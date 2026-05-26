import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (_error) {
  console.log("SKIP playwright smoke: playwright package is not installed.");
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(__dirname, "..", "MoClaw_Operating_Dashboard_Web.html");
const dashboardUrl = pathToFileURL(dashboardPath).href;

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (error) {
  if (String(error && error.message || error).includes("Executable doesn't exist")) {
    console.log("SKIP playwright smoke: playwright browser executable is not installed.");
    process.exit(0);
  }
  throw error;
}
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto(dashboardUrl);
  await page.evaluate(() => localStorage.removeItem("moclaw-operating-dashboard-comments"));
  await page.reload();

  await page.locator(".tab", { hasText: "用户获取" }).click();
  await page.waitForSelector(".sheet.on");

  await page.evaluate(() => window.scrollTo(0, 260));
  await page.waitForTimeout(50);
  const headerBoxAfter = await page.locator(".header-block").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
  });
  assert.ok(headerBoxAfter.top >= 0, "header block should not scroll above the viewport");
  assert.ok(headerBoxAfter.bottom > headerBoxAfter.top, "header block should remain visible while the page scrolls");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(50);

  await page.locator(".comment-fab").click();
  const targetCell = page
    .locator('.sheet.on [data-anchor-type="cell"][data-anchor-row-label="广告花费"][data-anchor-column-label="05-15"]')
    .first();
  await targetCell.click();

  await page.locator(".comment-composer textarea").fill("smoke: 广告花费 05-15");
  await page.locator(".comment-composer button.primary").click();
  await page.waitForSelector(".comment-pin");

  const pinCount = await page.locator(".comment-pin").count();
  assert.equal(pinCount, 1, "one open thread should render one visible pin");

  await page.locator(".comment-pin").first().click();
  await page.waitForSelector(".comment-popover");
  const popoverText = await page.locator(".comment-popover").innerText();
  assert.match(popoverText, /smoke: 广告花费 05-15/);

  const leftPaneRightBefore = await page.locator(".sheet.on .left-pane").first().evaluate((element) => {
    return Math.round(element.getBoundingClientRect().right);
  });
  await page.evaluate(() => {
    const rightPane = document.querySelector(".sheet.on .right-pane");
    rightPane.scrollLeft = 220;
    rightPane.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(50);

  const leftPaneRightAfter = await page.locator(".sheet.on .left-pane").first().evaluate((element) => {
    return Math.round(element.getBoundingClientRect().right);
  });
  assert.equal(leftPaneRightAfter, leftPaneRightBefore, "frozen left column should stay aligned after horizontal scroll");

  console.log("PASS playwright smoke: comment create, pin, popover, sticky header, frozen column.");
} finally {
  await browser.close();
}
