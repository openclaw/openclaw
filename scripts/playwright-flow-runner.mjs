#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

function parseArgs(argv) {
  const args = {
    spec: null,
    baseUrl: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:18789",
    artifacts: ".artifacts/playwright-flows",
    timeoutMs: 15_000,
    headed: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--spec") {
      args.spec = argv[++i] ?? args.spec;
    } else if (arg === "--base-url") {
      args.baseUrl = argv[++i] ?? args.baseUrl;
    } else if (arg === "--artifacts") {
      args.artifacts = argv[++i] ?? args.artifacts;
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++i] ?? args.timeoutMs);
    } else if (arg === "--headed") {
      args.headed = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!args.spec) {
    throw new Error("--spec is required");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be positive");
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/playwright-flow-runner.mjs --spec <flow.json> [options]

Run a browser automation flow described as JSON and save screenshots/traces.

Options:
  --spec <path>          Flow spec JSON
  --base-url <url>       Base URL for relative navigation
  --artifacts <dir>      Artifact output directory
  --timeout-ms <ms>      Default action timeout
  --headed               Show the browser window

Set PLAYWRIGHT_CHROME_EXECUTABLE when browsers are not installed by Playwright.
`);
}

function resolveExecutable() {
  const configured = process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  if (configured) {
    return configured;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function safeName(value) {
  return (
    String(value)
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "flow"
  );
}

function resolveUrl(baseUrl, target) {
  return new URL(target, baseUrl).toString();
}

async function runStep(page, step, context) {
  const timeout = step.timeoutMs ?? context.timeoutMs;
  if (step.action === "goto") {
    await page.goto(resolveUrl(context.baseUrl, step.url), {
      waitUntil: step.waitUntil ?? "domcontentloaded",
      timeout,
    });
  } else if (step.action === "click") {
    await page.locator(step.selector).click({ timeout });
  } else if (step.action === "fill") {
    await page.locator(step.selector).fill(step.value ?? "", { timeout });
  } else if (step.action === "press") {
    await page.locator(step.selector ?? "body").press(step.key, { timeout });
  } else if (step.action === "waitForSelector") {
    await page.locator(step.selector).waitFor({ state: step.state ?? "visible", timeout });
  } else if (step.action === "assertText") {
    const text = await page.locator(step.selector ?? "body").innerText({ timeout });
    if (!text.includes(step.text)) {
      throw new Error(`Expected text ${JSON.stringify(step.text)} in ${step.selector ?? "body"}`);
    }
  } else if (step.action === "screenshot") {
    await page.screenshot({
      path: path.join(
        context.artifacts,
        `${String(context.index).padStart(2, "0")}-${safeName(step.name ?? step.action)}.png`,
      ),
      fullPage: step.fullPage !== false,
    });
  } else {
    throw new Error(`Unsupported step action: ${step.action}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = path.resolve(args.spec);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  if (!Array.isArray(spec.steps)) {
    throw new Error("Flow spec must contain a steps array");
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(spec.name ?? path.basename(specPath))}`;
  const artifacts = path.resolve(args.artifacts, runId);
  mkdirSync(artifacts, { recursive: true });

  const executablePath = resolveExecutable();
  const browser = await chromium.launch({
    headless: !args.headed,
    executablePath,
  });
  const context = await browser.newContext({
    baseURL: args.baseUrl,
    recordVideo: { dir: artifacts },
    viewport: spec.viewport ?? { width: 1440, height: 1000 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const results = [];

  try {
    for (let i = 0; i < spec.steps.length; i += 1) {
      const step = spec.steps[i];
      const startedAt = Date.now();
      try {
        await runStep(page, step, { ...args, artifacts, index: i + 1 });
        results.push({
          index: i + 1,
          action: step.action,
          ok: true,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        const screenshot = path.join(artifacts, `${String(i + 1).padStart(2, "0")}-failure.png`);
        await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
        results.push({
          index: i + 1,
          action: step.action,
          ok: false,
          durationMs: Date.now() - startedAt,
          error: err.message,
          screenshot,
        });
        throw err;
      }
    }
  } finally {
    await context.tracing.stop({ path: path.join(artifacts, "trace.zip") }).catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    writeFileSync(
      path.join(artifacts, "result.json"),
      `${JSON.stringify({ spec: specPath, baseUrl: args.baseUrl, results }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  console.log(`flow ok: ${spec.name ?? specPath}`);
  console.log(`artifacts: ${artifacts}`);
}

main().catch((err) => {
  console.error(`flow failed: ${err.message}`);
  process.exit(1);
});
