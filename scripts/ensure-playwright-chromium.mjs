#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const UI_PACKAGE_JSON = path.join(ROOT, "ui", "package.json");

export function systemBrowserCandidates(runtimePlatform = process.platform) {
  if (runtimePlatform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (runtimePlatform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}

export function selectBrowserExecutable(input) {
  const {
    allowSystemBrowser = false,
    bundledPath,
    explicitPath = "",
    pathExists = existsSync,
    runtimePlatform = process.platform,
  } = input;
  const explicit = explicitPath.trim();
  if (explicit) {
    return pathExists(explicit)
      ? {
          status: "pass",
          executablePath: explicit,
          source: "explicit",
          blocker: null,
          warnings: [],
        }
      : {
          status: "blocked",
          executablePath: explicit,
          source: "explicit",
          blocker: `Explicit browser path does not exist: ${explicit}`,
          warnings: [],
        };
  }
  if (bundledPath && pathExists(bundledPath)) {
    return {
      status: "pass",
      executablePath: bundledPath,
      source: "playwright-bundled",
      blocker: null,
      warnings: [],
    };
  }
  if (!allowSystemBrowser) {
    return {
      status: "blocked",
      executablePath: bundledPath || null,
      source: "playwright-bundled",
      blocker:
        `Playwright bundled Chromium is missing${bundledPath ? ` at ${bundledPath}` : ""}. ` +
        "Run `pnpm --dir ui exec playwright install chromium` or explicitly set " +
        "`OPENCLAW_CONTROL_UI_SMOKE_ALLOW_SYSTEM_BROWSER=1` for a non-hermetic system-browser smoke.",
      warnings: [],
    };
  }
  const systemBrowser = systemBrowserCandidates(runtimePlatform).find((candidate) =>
    pathExists(candidate),
  );
  return systemBrowser
    ? {
        status: "pass",
        executablePath: systemBrowser,
        source: "system-browser",
        blocker: null,
        warnings: [
          "Using a system browser fallback; this is lower hermeticity than bundled Playwright Chromium.",
        ],
      }
    : {
        status: "blocked",
        executablePath: null,
        source: "system-browser",
        blocker: "System browser fallback was allowed, but no supported system browser was found.",
        warnings: [],
      };
}

function parseArgs(argv) {
  return {
    allowInstall:
      argv.includes("--install") || process.env.OPENCLAW_CONTROL_UI_SMOKE_INSTALL_BROWSER === "1",
    allowSystemBrowser:
      argv.includes("--allow-system-browser") ||
      process.env.OPENCLAW_CONTROL_UI_SMOKE_ALLOW_SYSTEM_BROWSER === "1",
    json: argv.includes("--json") || process.env.OPENCLAW_JSON === "1",
    skipLaunch: argv.includes("--skip-launch"),
  };
}

function resolvePlaywrightFromUi() {
  const require = createRequire(UI_PACKAGE_JSON);
  const packageJsonPath = require.resolve("playwright/package.json");
  const packageJson = require(packageJsonPath);
  const entryPath = require.resolve("playwright");
  const playwright = require("playwright");
  return { entryPath, packageJson, packageJsonPath, playwright };
}

function runInstall() {
  const result = spawnSync("pnpm", ["--dir", "ui", "exec", "playwright", "install", "chromium"], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command: "pnpm --dir ui exec playwright install chromium",
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout?.slice(0, 4000) ?? "",
    stderr: result.stderr?.slice(0, 4000) ?? "",
    error: result.error?.message ?? null,
  };
}

async function launchTinyPage(playwright, executablePath) {
  const startedAt = Date.now();
  const browser = await playwright.chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<main>SNES Studio browser proof</main>");
    const text = await page.textContent("main");
    return { elapsedMs: Date.now() - startedAt, text };
  } finally {
    await browser.close();
  }
}

export async function createPlaywrightChromiumReport(options = {}) {
  const generatedAt = new Date().toISOString();
  const installAttempts = [];
  let playwrightInfo;
  try {
    playwrightInfo = resolvePlaywrightFromUi();
  } catch (error) {
    return {
      format: "openclaw-playwright-chromium-proof-v1",
      generatedAt,
      status: "blocked",
      proofTier: "browser-launch",
      productionBrowserEquivalent: true,
      blocker: `Unable to resolve Playwright from ui workspace: ${error.message}`,
      installAttempts,
    };
  }
  const playwright = playwrightInfo.playwright;
  const bundledPath = playwright.chromium.executablePath();
  let selected = selectBrowserExecutable({
    allowSystemBrowser: options.allowSystemBrowser,
    bundledPath,
    explicitPath: process.env.OPENCLAW_CONTROL_UI_SMOKE_BROWSER ?? "",
  });
  if (selected.status !== "pass" && options.allowInstall) {
    installAttempts.push(runInstall());
    selected = selectBrowserExecutable({
      allowSystemBrowser: options.allowSystemBrowser,
      bundledPath,
      explicitPath: process.env.OPENCLAW_CONTROL_UI_SMOKE_BROWSER ?? "",
    });
  }
  if (selected.status !== "pass") {
    return {
      format: "openclaw-playwright-chromium-proof-v1",
      generatedAt,
      status: "blocked",
      proofTier: "browser-launch",
      productionBrowserEquivalent: true,
      playwrightVersion: playwrightInfo.packageJson.version,
      bundledPath,
      selected,
      installAttempts,
      blocker: selected.blocker,
    };
  }
  if (options.skipLaunch) {
    return {
      format: "openclaw-playwright-chromium-proof-v1",
      generatedAt,
      status: "pass",
      proofTier: "browser-launch",
      productionBrowserEquivalent: true,
      playwrightVersion: playwrightInfo.packageJson.version,
      bundledPath,
      selected,
      installAttempts,
      launch: { skipped: true },
      blocker: null,
    };
  }
  try {
    const launch = await launchTinyPage(playwright, selected.executablePath);
    return {
      format: "openclaw-playwright-chromium-proof-v1",
      generatedAt,
      status: launch.text === "SNES Studio browser proof" ? "pass" : "blocked",
      proofTier: "browser-launch",
      productionBrowserEquivalent: true,
      playwrightVersion: playwrightInfo.packageJson.version,
      bundledPath,
      selected,
      installAttempts,
      launch,
      blocker:
        launch.text === "SNES Studio browser proof"
          ? null
          : "Playwright launched, but the tiny-page text proof did not match.",
    };
  } catch (error) {
    return {
      format: "openclaw-playwright-chromium-proof-v1",
      generatedAt,
      status: "blocked",
      proofTier: "browser-launch",
      productionBrowserEquivalent: true,
      playwrightVersion: playwrightInfo.packageJson.version,
      bundledPath,
      selected,
      installAttempts,
      blocker: `Playwright browser launch failed: ${error.message}`,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await createPlaywrightChromiumReport(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.status === "pass") {
    process.stdout.write(`Playwright Chromium proof passed: ${report.selected.executablePath}\n`);
  } else {
    process.stderr.write(`Playwright Chromium proof blocked: ${report.blocker}\n`);
  }
  process.exit(report.status === "pass" ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
