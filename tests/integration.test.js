const axios = require('axios');
const cheerio = require('cheerio');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { sampleHtmlWithYale } = require('./test-utils');
const nock = require('nock');
const fs = require('fs').promises;

// Set a different port for testing to avoid conflict with the main app
const TEST_PORT = 3099;
let serverPid;

describe('Integration Tests', () => {
  // Modify the app to use a test port
  beforeAll(async () => {
    // Mock external HTTP requests but allow localhost
    nock.disableNetConnect();
    nock.enableNetConnect(/^(localhost|127\.0\.0\.1)/);
    
    // Create a temporary test app file with modified port
    const appContent = await fs.readFile('app.js', 'utf8');
    const modifiedContent = appContent.replace('const PORT = 3001', `const PORT = ${TEST_PORT}`);
    await fs.writeFile('app.test.js', modifiedContent);
    
    // Start the test server
    const server = require('child_process').spawn('node', ['app.test.js'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Store only the PID to avoid circular reference issues
    serverPid = server.pid;
    
    // Wait for server to be ready by checking if port is listening
    let retries = 20;
    while (retries > 0) {
      try {
        await axios.get(`http://localhost:${TEST_PORT}/`);
        break;
      } catch (err) {
        retries--;
        if (retries === 0) {
          throw new Error('Server failed to start');
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    server.unref(); // Allow the parent process to exit independently
  }, 15000); // Increase timeout for server startup

  afterAll(async () => {
    // Kill the test server and clean up
    if (serverPid) {
      try {
        process.kill(-serverPid);
      } catch (error) {
        // Process may already be dead
      }
    }
    await execAsync('rm -f app.test.js');
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test('Should replace Yale with Fale in fetched content', async () => {
    // Setup mock for example.com
    const scope = nock('https://example.com')
      .get('/')
      .reply(200, sampleHtmlWithYale);
    
    // Make a request to our proxy app
    let status, success, content;
    try {
      const response = await axios.post(`http://localhost:${TEST_PORT}/fetch`, {
        url: 'https://example.com/'
      });
      
      // Extract only the data we need to avoid circular references
      status = response.status;
      success = response.data.success;
      content = response.data.content;
    } catch (err) {
      // Don't store the error object
      throw new Error(err.message);
    }
    
    expect(status).toBe(200);
    expect(success).toBe(true);
    
    // Verify Yale has been replaced with Fale in text
    const $ = cheerio.load(content);
    expect($('title').text()).toBe('Fale University Test Page');
    expect($('h1').text()).toBe('Welcome to Fale University');
    expect($('p').first().text()).toContain('Fale University is a private');
    
    // Verify URLs remain unchanged
    const links = $('a');
    let hasYaleUrl = false;
    links.each((i, link) => {
      const href = $(link).attr('href');
      if (href && href.includes('yale.edu')) {
        hasYaleUrl = true;
      }
    });
    expect(hasYaleUrl).toBe(true);
    
    // Verify link text is changed
    expect($('a').first().text()).toBe('About Fale');
    
    // Clean up nock scope
    scope.done();
  }, 10000); // Increase timeout for this test

  test('Should handle invalid URLs', async () => {
    let errorStatus;
    try {
      await axios.post(`http://localhost:${TEST_PORT}/fetch`, {
        url: 'not-a-valid-url'
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      // Extract only the status to avoid circular references
      errorStatus = error.response?.status || error.status;
    }
    expect(errorStatus).toBe(500);
  });

  test('Should handle missing URL parameter', async () => {
    let errorStatus, errorMessage;
    try {
      await axios.post(`http://localhost:${TEST_PORT}/fetch`, {});
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      // Extract only the data we need to avoid circular references
      errorStatus = error.response?.status || error.status;
      errorMessage = error.response?.data?.error;
    }
    expect(errorStatus).toBe(400);
    expect(errorMessage).toBe('URL is required');
  });
});
