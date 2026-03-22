#!/usr/bin/env bash
# web-screenshot: Reliable full-page screenshots with scroll-reveal fix
# Usage: screenshot.sh <url> <output-dir> [slug]
#
# Takes desktop (1280px) and mobile (375px) full-page screenshots,
# forcing all scroll-reveal animations visible before capture.
#
# Requires: Node.js + Playwright (npx playwright install chromium)

set -euo pipefail

URL="${1:?Usage: screenshot.sh <url> <output-dir> [slug]}"
OUTPUT_DIR="${2:?Usage: screenshot.sh <url> <output-dir> [slug]}"
SLUG="${3:-screenshot}"

mkdir -p "$OUTPUT_DIR"

node - "$URL" "$OUTPUT_DIR" "$SLUG" << 'NODESCRIPT'
const { chromium } = require('playwright');

(async () => {
  const [,, url, outputDir, slug] = process.argv;

  const browser = await chromium.launch({ headless: true });

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
    window.scrollTo(0, document.body.scrollHeight);
  `;

  // Desktop screenshot (1280px)
  const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desktopPage.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await desktopPage.evaluate(revealScript);
  await desktopPage.waitForTimeout(2000);
  await desktopPage.evaluate(() => window.scrollTo(0, 0));
  await desktopPage.waitForTimeout(1000);
  await desktopPage.screenshot({ path: `${outputDir}/${slug}-desktop.png`, fullPage: true });
  console.log(`✅ Desktop: ${outputDir}/${slug}-desktop.png`);
  await desktopPage.close();

  // Mobile screenshot (375px)
  const mobilePage = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await mobilePage.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await mobilePage.evaluate(revealScript);
  await mobilePage.waitForTimeout(2000);
  await mobilePage.evaluate(() => window.scrollTo(0, 0));
  await mobilePage.waitForTimeout(1000);
  await mobilePage.screenshot({ path: `${outputDir}/${slug}-mobile.png`, fullPage: true });
  console.log(`✅ Mobile: ${outputDir}/${slug}-mobile.png`);
  await mobilePage.close();

  await browser.close();
  console.log('Done.');
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
NODESCRIPT
