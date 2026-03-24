#!/usr/bin/env bash
# web-screenshot: Reliable full-page screenshots with scroll-reveal fix
# Usage: screenshot.sh <url> <output-dir> [slug]
#
# Takes desktop (1280px) and mobile (375px) full-page screenshots,
# forcing all scroll-reveal animations visible before capture.
#
# Requirements: Node.js + Playwright
#   npm install playwright
#   npx playwright install chromium

set -euo pipefail

URL="${1:?Usage: screenshot.sh <url> <output-dir> [slug]}"
OUTPUT_DIR="${2:?Usage: screenshot.sh <url> <output-dir> [slug]}"
SLUG="${3:-screenshot}"

mkdir -p "$OUTPUT_DIR"

node - "$URL" "$OUTPUT_DIR" "$SLUG" << 'NODESCRIPT'
const { chromium, devices } = require('playwright');

const revealScript = `
  document.querySelectorAll('[class*="reveal"], [class*="fade"], [class*="animate"], [class*="scroll"]').forEach(el => {
    el.style.opacity = '1';
    el.style.transform = 'none';
    el.style.visibility = 'visible';
    el.style.transition = 'none';
  });
  document.querySelectorAll('[style*="opacity: 0"], [style*="opacity:0"]').forEach(el => {
    el.style.opacity = '1';
    el.style.transform = 'none';
  });
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    img.loading = 'eager';
    if (img.dataset.src) img.src = img.dataset.src;
  });
`;

const scrollScript = `
  (async () => {
    const h = document.body.scrollHeight;
    const step = Math.ceil(h / 10);
    for (let i = step; i <= h; i += step) {
      window.scrollTo(0, i);
      await new Promise(r => setTimeout(r, 300));
    }
  })()
`;

async function captureScreenshot(browser, url, outputPath, viewportOpts) {
  const page = await browser.newPage(viewportOpts);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(revealScript);
  await page.evaluate(scrollScript);
  await page.waitForTimeout(2000);
  // Re-apply reveal after scroll (some observers may have added new classes)
  await page.evaluate(revealScript);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(`✅ ${outputPath}`);
  await page.close();
}

let browser;
(async () => {
  const [,, url, outputDir, slug] = process.argv;

  browser = await chromium.launch({ headless: true });

  // Desktop screenshot (1280px)
  await captureScreenshot(browser, url, `${outputDir}/${slug}-desktop.png`, {
    viewport: { width: 1280, height: 800 }
  });

  // Mobile screenshot (iPhone 14-like with proper user agent)
  const iPhone = devices['iPhone 14'];
  await captureScreenshot(browser, url, `${outputDir}/${slug}-mobile.png`, {
    ...iPhone
  });

  await browser.close();
  console.log('Done.');
})().catch(async err => {
  console.error('Error:', err.message);
  if (browser) await browser.close().catch(() => {});
  process.exit(1);
});
NODESCRIPT
