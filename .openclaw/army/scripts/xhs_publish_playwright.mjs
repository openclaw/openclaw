#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args[name] = value;
  }
  return args;
}

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      await el.fill(value);
      return true;
    }
  }
  return false;
}

async function clickPublish(page) {
  const labels = ["发布", "立即发布", "发布笔记"];
  for (const label of labels) {
    const btn = page.getByRole("button", { name: label }).first();
    if ((await btn.count()) > 0) {
      await btn.click();
      return true;
    }
  }
  const fallback = page.locator('button:has-text("发布"),button:has-text("立即发布")').first();
  if ((await fallback.count()) > 0) {
    await fallback.click();
    return true;
  }
  return false;
}

(async () => {
  const args = parseArgs(process.argv);
  const inputPath = args.input;
  const setupLogin = args["setup-login"] === "true";
  const dryRun = args["dry-run"] === "true";

  const executablePath =
    process.env.XHS_CHROME_PATH ||
    "/Users/jack/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

  if (!fs.existsSync(executablePath)) {
    console.error(JSON.stringify({ ok: false, error: "BROWSER_NOT_FOUND", executablePath }));
    process.exit(2);
  }

  const profileDir =
    process.env.XHS_PROFILE_DIR || path.join(os.homedir(), ".openclaw", "xhs-browser-profile");
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());

  if (setupLogin) {
    await page.goto("https://creator.xiaohongshu.com/", { waitUntil: "domcontentloaded" });
    console.log(
      JSON.stringify({
        ok: true,
        mode: "setup-login",
        message: "请在打开的浏览器里完成小红书登录，登录后手动关闭浏览器窗口即可保存会话。",
      }),
    );
    return;
  }

  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(JSON.stringify({ ok: false, error: "INPUT_NOT_FOUND", inputPath }));
    process.exit(2);
  }

  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const title = String(payload.title || "").trim();
  const content = String(payload.content || "").trim();
  const tags = Array.isArray(payload.tags) ? payload.tags : [];

  if (!title || !content) {
    console.error(
      JSON.stringify({ ok: false, error: "INVALID_PAYLOAD", need: ["title", "content"] }),
    );
    process.exit(2);
  }

  await page.goto("https://creator.xiaohongshu.com/publish/publish", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2000);

  const loginHint = await page.locator("text=登录, text=扫码登录").count();
  if (loginHint > 0) {
    console.error(
      JSON.stringify({ ok: false, error: "LOGIN_REQUIRED", hint: "先运行 --setup-login 完成登录" }),
    );
    process.exit(3);
  }

  const titleFilled = await fillFirst(
    page,
    ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]'],
    title,
  );
  const contentFilled = await fillFirst(
    page,
    [
      'div[contenteditable="true"]',
      'textarea[placeholder*="正文"]',
      'textarea[placeholder*="描述"]',
    ],
    `${content}\n\n${tags.map((t) => `#${String(t).replace(/^#/, "")}`).join(" ")}`,
  );

  if (!titleFilled || !contentFilled) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "EDITOR_NOT_FOUND",
        titleFilled,
        contentFilled,
        url: page.url(),
      }),
    );
    process.exit(4);
  }

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, title, tagsCount: tags.length }));
    await context.close();
    process.exit(0);
  }

  const clicked = await clickPublish(page);
  if (!clicked) {
    console.error(JSON.stringify({ ok: false, error: "PUBLISH_BUTTON_NOT_FOUND" }));
    process.exit(5);
  }

  await page.waitForTimeout(3000);
  console.log(JSON.stringify({ ok: true, published: true, title }));
  await context.close();
})().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, error: "UNHANDLED", message: String(error?.message || error) }),
  );
  process.exit(1);
});
