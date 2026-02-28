const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function main() {
  const args = process.argv.slice(2);
  const url = args[0];

  if (!url || url.startsWith('--')) {
    console.error('Usage: node browse.js <URL> [OPTIONS]');
    console.error('Options:');
    console.error('  --extract-text');
    console.error('  --extract-html');
    console.error('  --screenshot <filepath>');
    console.error('  --wait-for <selector>');
    console.error('  --evaluate <js_code>');
    process.exit(1);
  }

  let extractText = args.includes('--extract-text');
  let extractHtml = args.includes('--extract-html');
  
  let screenshotPath = null;
  const screenshotIdx = args.indexOf('--screenshot');
  if (screenshotIdx !== -1 && screenshotIdx + 1 < args.length) {
    screenshotPath = args[screenshotIdx + 1];
  }

  let waitForSelector = null;
  const waitForIdx = args.indexOf('--wait-for');
  if (waitForIdx !== -1 && waitForIdx + 1 < args.length) {
    waitForSelector = args[waitForIdx + 1];
  }

  let evaluateScript = null;
  const evalIdx = args.indexOf('--evaluate');
  if (evalIdx !== -1 && evalIdx + 1 < args.length) {
    evaluateScript = args[evalIdx + 1];
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Set a modern viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Navigate with a reasonable timeout
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 10000 });
    }

    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Screenshot saved to: ${screenshotPath}`);
    }

    if (evaluateScript) {
      const result = await page.evaluate((script) => {
        return eval(script);
      }, evaluateScript);
      console.log('--- EVALUATE RESULT ---');
      console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
    }

    if (extractText) {
      const text = await page.evaluate(() => document.body.innerText);
      console.log('--- EXTRACTED TEXT ---');
      console.log(text);
    }

    if (extractHtml) {
      const html = await page.content();
      console.log('--- EXTRACTED HTML ---');
      console.log(html);
    }

    // Default output if nothing specified
    if (!extractText && !extractHtml && !screenshotPath && !evaluateScript) {
      const title = await page.title();
      console.log(`Successfully navigated to ${url}. Page Title: "${title}"`);
    }

  } catch (error) {
    console.error('Error during headless browser execution:', error);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

main();
