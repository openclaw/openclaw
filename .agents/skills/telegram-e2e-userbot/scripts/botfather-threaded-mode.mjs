import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function setBotFatherThreadedMode({ urlFile, username, enabled, chromium }) {
  let browser;
  let state;
  let failure;
  try {
    if ((fs.statSync(urlFile).mode & 0o077) !== 0) {
      throw new Error("Mini App URL file must be private.");
    }
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    await page.goto(fs.readFileSync(urlFile, "utf8"), {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await page
      .getByText(new RegExp(`@${username}(?![A-Za-z0-9_])`, "i"))
      .first()
      .click({ timeout: 30_000 });
    await page.getByText("Bot Settings", { exact: true }).first().click();
    const toggle = page.getByText("Threaded Mode", { exact: true }).first();
    await toggle.waitFor({ state: "visible" });
    await page.waitForLoadState("networkidle");
    const enabledMarker = page
      .getByText("Disallow users to create new threads", { exact: false })
      .first();
    const before = await enabledMarker.isVisible();
    if (before !== enabled) {
      await toggle.click();
      await page.waitForLoadState("networkidle");
      await enabledMarker.waitFor({ state: enabled ? "visible" : "hidden", timeout: 30_000 });
    }
    const after = await enabledMarker.isVisible();
    if (after !== enabled) {
      throw new Error("Threaded Mode was not confirmed.");
    }
    state = { before, after };
  } catch {
    // Navigation errors can embed the signed Mini App URL. Keep diagnostics credential-free.
    failure = new Error("BotFather Threaded Mode could not be confirmed.");
  }
  try {
    await browser?.close();
  } catch {
    failure ??= new Error("BotFather browser cleanup failed.");
  }
  if (failure) {
    throw failure;
  }
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [urlFile, username, mode] = process.argv.slice(2);
  try {
    if (!urlFile || !username || !["on", "off"].includes(mode) || process.argv.length !== 5) {
      throw new Error("Invalid Threaded Mode helper arguments.");
    }
    // Playwright API tracing includes navigation URLs, which contain session credentials.
    delete process.env.DEBUG;
    delete process.env.PWDEBUG;
    const { chromium } = await import("playwright");
    console.log(
      JSON.stringify(
        await setBotFatherThreadedMode({ urlFile, username, enabled: mode === "on", chromium }),
      ),
    );
  } catch {
    console.error("BotFather Threaded Mode action failed.");
    process.exitCode = 1;
  }
}
