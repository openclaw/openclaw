#!/usr/bin/env node
/**
 * OpenClaw Browser CLI
 *
 * Standalone browser control tool using playwright-core via CDP.
 * Workaround for Ubuntu/Linux systems where OpenClaw's browser tool
 * `act` actions timeout.
 *
 * Usage:
 *   browser navigate "https://example.com"
 *   browser click "text=Submit"
 *   browser type "input[name=email]" "user@example.com"
 *   browser snapshot
 *
 * Environment:
 *   CDP_URL - Chrome DevTools Protocol URL (default: http://127.0.0.1:18800)
 */

const { chromium } = require("playwright-core");

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:18800";

async function connect() {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("No browser context found. Is Chrome running with --remote-debugging-port?");
    }
    const page = context.pages()[0];
    if (!page) {
      throw new Error("No page found. Open a tab in Chrome first.");
    }
    return { browser, context, page };
  } catch (e) {
    if (e.message.includes("ECONNREFUSED")) {
      throw new Error(
        `Cannot connect to Chrome at ${CDP_URL}. Start Chrome with: google-chrome --remote-debugging-port=18800`,
      );
    }
    throw e;
  }
}

async function navigate(url) {
  const { browser, page } = await connect();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log(JSON.stringify({ ok: true, url: page.url(), title: await page.title() }));
  await browser.close();
}

async function click(selector) {
  const { browser, page } = await connect();
  await page.locator(selector).first().click({ timeout: 10000 });
  console.log(JSON.stringify({ ok: true, clicked: selector, url: page.url() }));
  await browser.close();
}

async function type(selector, text) {
  const { browser, page } = await connect();
  await page.locator(selector).first().fill(text);
  console.log(JSON.stringify({ ok: true, typed: text, selector }));
  await browser.close();
}

async function press(key) {
  const { browser, page } = await connect();
  await page.keyboard.press(key);
  console.log(JSON.stringify({ ok: true, pressed: key }));
  await browser.close();
}

async function snapshot(maxLen = 2000) {
  const { browser, page } = await connect();
  const url = page.url();
  const title = await page.title();
  const text = await page.evaluate(() => document.body.innerText);
  console.log(
    JSON.stringify({
      ok: true,
      url,
      title,
      text: text.slice(0, parseInt(maxLen)),
    }),
  );
  await browser.close();
}

async function screenshot(path = "/tmp/screenshot.png") {
  const { browser, page } = await connect();
  await page.screenshot({ path, fullPage: false });
  console.log(JSON.stringify({ ok: true, path }));
  await browser.close();
}

async function evaluate(code) {
  const { browser, page } = await connect();
  const result = await page.evaluate(code);
  console.log(JSON.stringify({ ok: true, result }));
  await browser.close();
}

async function fill(fields) {
  // fields = "selector1=value1,selector2=value2"
  const { browser, page } = await connect();
  const pairs = fields.split(",").map((p) => {
    const idx = p.indexOf("=");
    return [p.slice(0, idx), p.slice(idx + 1)];
  });
  for (const [sel, val] of pairs) {
    if (sel && val !== undefined) {
      await page.locator(sel.trim()).first().fill(val.trim());
    }
  }
  console.log(JSON.stringify({ ok: true, filled: pairs.length }));
  await browser.close();
}

async function waitFor(selector, timeout = 10000) {
  const { browser, page } = await connect();
  await page
    .locator(selector)
    .first()
    .waitFor({ timeout: parseInt(timeout) });
  console.log(JSON.stringify({ ok: true, found: selector }));
  await browser.close();
}

async function info() {
  const { browser, page } = await connect();
  console.log(
    JSON.stringify({
      ok: true,
      url: page.url(),
      title: await page.title(),
    }),
  );
  await browser.close();
}

// Help text
const HELP = `
OpenClaw Browser CLI - Direct CDP browser control

Usage: browser <command> [args]

Commands:
  navigate <url>              Navigate to URL
  click <selector>            Click element (supports text=, css, xpath)
  type <selector> <text>      Type text into element
  press <key>                 Press keyboard key (Enter, Tab, Escape, etc.)
  snapshot [maxLen]           Get page text content (default: 2000 chars)
  screenshot [path]           Save screenshot (default: /tmp/screenshot.png)
  eval <code>                 Execute JavaScript in page context
  fill <sel=val,sel=val>      Fill multiple form fields
  wait <selector> [timeout]   Wait for element (default: 10000ms)
  info                        Get current URL and title

Environment:
  CDP_URL                     Chrome DevTools URL (default: http://127.0.0.1:18800)

Examples:
  browser navigate "https://google.com"
  browser type "input[name=q]" "hello world"
  browser click "text=Google Search"
  browser press Enter
  browser snapshot 5000
  browser screenshot ./page.png

Prerequisites:
  Start Chrome with remote debugging:
  google-chrome --remote-debugging-port=18800 --user-data-dir=/tmp/chrome-debug
`.trim();

// Main
const [, , cmd, ...args] = process.argv;

const commands = {
  navigate: () => navigate(args[0]),
  click: () => click(args[0]),
  type: () => type(args[0], args.slice(1).join(" ")),
  press: () => press(args[0]),
  snapshot: () => snapshot(args[0] || 2000),
  screenshot: () => screenshot(args[0]),
  eval: () => evaluate(args.join(" ")),
  fill: () => fill(args[0]),
  wait: () => waitFor(args[0], args[1]),
  info: () => info(),
  help: () => {
    console.log(HELP);
    process.exit(0);
  },
  "--help": () => {
    console.log(HELP);
    process.exit(0);
  },
  "-h": () => {
    console.log(HELP);
    process.exit(0);
  },
};

if (!cmd || !commands[cmd]) {
  console.log(HELP);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
