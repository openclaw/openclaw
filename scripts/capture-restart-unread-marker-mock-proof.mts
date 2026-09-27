#!/usr/bin/env node
/**
 * Fallback rendered proof for the Control UI session-sidebar unread marker.
 *
 * This lane installs the mocked Gateway (no real Gateway, no dispatch) and varies
 * only the `unread` fact on the projected session row, so it proves the RENDER
 * binding of the marker - not the restart-safe failed-turn flow that produces the
 * fact. Use it only when the real-Gateway capture
 * (`scripts/capture-restart-unread-proof.mts`) cannot run on this host.
 *
 * Usage:
 *   node --import ./scripts/tsx.mjs scripts/capture-restart-unread-marker-mock-proof.mts \
 *     --out <file.png> --mode after|before
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { readControlUiProofOption } from "./lib/control-ui-proof-args.mts";
import { formatErrorMessage } from "./lib/error-format.mts";

const OBSERVER_KEY = "agent:main:main";
const UNREAD_KEY = "agent:main:dashboard:synthetic-restart-unread";
const TS = Date.parse("2026-08-17T20:00:00.000Z");

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  extra: Record<string, unknown> = {},
) {
  return {
    contextTokens: 200_000,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: "gpt-5.6-luna",
    modelProvider: "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
    ...extra,
  };
}

function sessionsListResponse(sessions: unknown[]) {
  return {
    count: sessions.length,
    defaults: { contextTokens: 200_000, model: "gpt-5.6-luna", modelProvider: "openai" },
    hasMore: false,
    limitApplied: 50,
    nextOffset: null,
    offset: 0,
    path: "",
    sessions,
    totalCount: sessions.length,
    ts: TS,
  };
}

const out = readControlUiProofOption(process.argv, "out");
if (!out?.trim()) {
  throw new Error("--out <file.png> is required");
}
const mode = readControlUiProofOption(process.argv, "mode")?.trim() || "after";
if (mode !== "after" && mode !== "before") {
  throw new Error(`--mode must be after|before, received ${mode}`);
}
const outPath = path.resolve(out);
mkdirSync(path.dirname(outPath), { recursive: true });

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

// `after` shows the terminal state the restart-safe write produces (failed + unread);
// `before` keeps every other fact identical and only drops the unread projection.
const rows = [
  sessionRow(UNREAD_KEY, "Synthetic restart-safe ticket", TS - 1_000, {
    status: "failed",
    unread: mode === "after",
    ...(mode === "after" ? { lastActivityAt: TS } : {}),
  }),
  sessionRow(OBSERVER_KEY, "Synthetic observer session", TS - 60_000, { unread: false }),
];

const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
let failure: unknown;
try {
  const context = await browser.newContext({
    colorScheme: "dark",
    locale: "en-US",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await installMockGateway(page, {
    methodResponses: { "sessions.list": sessionsListResponse(rows) },
    sessionKey: OBSERVER_KEY,
  });
  try {
    await page.goto(controlUiSessionUrl(server.baseUrl, OBSERVER_KEY));
    await page.locator("openclaw-app-sidebar").waitFor({ state: "visible" });
    const row = page.locator(`openclaw-app-sidebar [data-session-key="${UNREAD_KEY}"]`);
    await row.waitFor({ state: "visible" });
    const dotCount = await row.locator(".sidebar-session-indicator .session-unread-dot").count();
    const badgeCount = await row
      .locator(".sidebar-session-indicator .session-glyph__badge--unread")
      .count();
    console.log(
      `[capture-mock] mode=${mode} dot=${dotCount} badge=${badgeCount} row=${(
        await row.evaluate((element) => element.outerHTML)
      ).slice(0, 900)}`,
    );
    // Fixed viewport clip: the sidebar occupies the left rail at 1280x900.
    await page.screenshot({
      animations: "disabled",
      clip: { height: 900, width: 560, x: 0, y: 0 },
      path: outPath,
    });
    const present = dotCount + badgeCount > 0;
    if (mode === "after" && !present) {
      throw new Error("mode=after must render the unread marker");
    }
    if (mode === "before" && present) {
      throw new Error("mode=before must not render the unread marker");
    }
    console.log(`[capture-mock] wrote ${outPath} (marker=${String(present)})`);
  } finally {
    await context.close();
  }
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await server.close();
}
if (failure) {
  console.error(`[capture-mock] FAILED: ${formatErrorMessage(failure)}`);
  process.exitCode = 1;
} else {
  process.exit(0);
}
