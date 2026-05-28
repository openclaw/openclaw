#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { resolveCapitalHftStateDir } from "./lib/brokerdesk-state-dir.mjs";
import { runAutoTradingLearningSnapshot } from "./openclaw-auto-trading-learning-snapshot.mjs";
import { runAutoTradingTickDiagnostic } from "./openclaw-auto-trading-tick-diagnostic.mjs";
import { runCapitalPaperAutomationLoop } from "./openclaw-capital-paper-automation-loop.mjs";

const DEFAULT_DEBOUNCE_MS = 1;

function defaultCapitalHftStateDir() {
  return resolveCapitalHftStateDir();
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function watchTargets(stateDir) {
  return [
    "capital_latest_quote_event.json",
    "capital_quote_events.jsonl",
    "openclaw_quote_bridge.json",
    "latest_quote_state.json",
    "capital_login_guard.json",
    "capital_quote_rotation_queue.json",
  ].map((fileName) => path.join(stateDir, fileName));
}

function defaultWatchStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "auto-trading-watch-state.json");
}

function defaultLearningSnapshotPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "auto-trading-learning-snapshot.json");
}

function defaultLearningSummaryPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "auto-trading-learning-summary.md");
}

function defaultTickDiagnosticPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-tick-diagnostic.json");
}

function defaultStartupStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "auto-trading-watch-startup-state.json");
}

function defaultServiceStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "service", "auto-trading-watch-service.json");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function captureHighResClock() {
  const epochMs = performance.timeOrigin + performance.now();
  return {
    observedAt: new Date(epochMs).toISOString(),
    observedAtEpochMs: epochMs,
    observedAtEpochMicros: Math.round(epochMs * 1000),
  };
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function formatRefreshLine(report, tickDiagnostic, triggerPath, daemon) {
  const latestOverallQuote = tickDiagnostic?.latestOverallQuote ?? {};
  const latestTradeQuote = tickDiagnostic?.latestTradeQuote ?? {};
  const freshTradeQuote = tickDiagnostic?.freshTradeQuote ?? {};
  const intent = report?.trading?.paperIntentCreated ? report.trading.paperIntentId : "none";
  const currentQuote = freshTradeQuote.stockNo
    ? `${freshTradeQuote.stockNo}/${freshTradeQuote.stockName}`
    : "NONE";
  const latestQuote = latestTradeQuote.stockNo
    ? `${latestTradeQuote.stockNo}/${latestTradeQuote.stockName}`
    : "NONE";
  return [
    "[auto-trading-watch]",
    triggerPath ? `trigger=${triggerPath}` : "trigger=startup",
    `status=${report?.status ?? ""}`,
    `quote=${report?.pump?.status ?? ""}`,
    `freshness=${report?.readiness?.status ?? ""}`,
    `tick=${tickDiagnostic?.status ?? ""}`,
    `bg=${tickDiagnostic?.bridge?.status ?? ""}${tickDiagnostic?.bridge?.overallReady ? ":ready" : ""}${tickDiagnostic?.bridge?.quoteEventConfirmed ? ":confirmed" : ""}`,
    `bgHeartbeat=${tickDiagnostic?.bridge?.lastHeartbeatAt ?? ""}`,
    `paperIntent=${intent}`,
    `freshQuote=${tickDiagnostic?.freshQuoteAvailable ? "yes" : "no"}`,
    `currentQuote=${currentQuote}`,
    `latestQuote=${latestQuote}`,
    `rawQuote=${latestOverallQuote.stockNo || "NONE"}`,
    freshTradeQuote.close ? `close=${freshTradeQuote.close}` : "",
    `daemon=${daemon?.status ?? ""}${daemon?.pid ? `#${daemon.pid}` : ""}`,
    `next=${report?.nextSafeTask ?? ""}`,
  ]
    .filter(Boolean)
    .join(" ");
}

async function runRefresh(repoRoot, stateDir, debounceMs, jsonMode, triggerPath) {
  const previousWatchState = await readJsonOptional(defaultWatchStatePath(repoRoot));
  const result = await runCapitalPaperAutomationLoop({
    repoRoot,
    stateDir,
  });
  const tickDiagnostic = await runAutoTradingTickDiagnostic({
    repoRoot,
    reportPath: defaultTickDiagnosticPath(repoRoot),
  });
  const assistantState = JSON.parse(
    (await fs.readFile(result.report.files.assistantStatePath, "utf8")).replace(/^\uFEFF/, ""),
  );
  const serviceState = JSON.parse(
    (await fs.readFile(defaultServiceStatePath(repoRoot), "utf8")).replace(/^\uFEFF/, ""),
  );
  const clock = captureHighResClock();
  const watchState = {
    schema: "openclaw.capital.auto-trading-watch-state.v1",
    generatedAt: new Date().toISOString(),
    clock,
    repoRoot,
    stateDir,
    triggerPath: triggerPath || "startup",
    status: result.report.status,
    watch: {
      enabled: true,
      debounceMs,
      targets: watchTargets(stateDir),
    },
    assistant: {
      status: assistantState.status ?? "",
      name: assistantState.assistant?.name ?? "類高頻自動交易助手",
      fastOrderPaperPattern:
        assistantState.summary?.fastOrderPaperPattern ??
        assistantState.fastOrderPaperPattern?.pattern ??
        "no-paper-execution",
      fastOrderPaperSuccessCount: Number.isFinite(
        Number(assistantState.summary?.fastOrderPaperSuccessCount),
      )
        ? Number(assistantState.summary.fastOrderPaperSuccessCount)
        : 0,
      fastOrderPaperFailureCount: Number.isFinite(
        Number(assistantState.summary?.fastOrderPaperFailureCount),
      )
        ? Number(assistantState.summary.fastOrderPaperFailureCount)
        : 0,
      latestFastOrderStatus:
        assistantState.summary?.latestFastOrderStatus ??
        assistantState.fastOrderPaperPattern?.latestStatus ??
        "none",
      entrypoints: Array.isArray(assistantState.assistant?.entrypoints)
        ? Array.from(
            new Set([
              ...assistantState.assistant.entrypoints,
              "pnpm capital-hft:auto-trading-watch:daemon-check",
            ]),
          )
        : ["pnpm capital-hft:auto-trading-watch:daemon-check"],
      nextSafeTask: assistantState.nextSafeTask ?? result.report.nextSafeTask ?? "",
    },
    loop: {
      status: result.report.status,
      pumpStatus: result.report.pump.status,
      readinessStatus: result.report.readiness.status,
      paperIntentCreated: result.report.trading.paperIntentCreated,
      learningStatus: result.report.learning.status,
      paperEligible: result.report.learning.paperEligible,
      liveEligible: result.report.learning.liveEligible,
    },
    tickDiagnostic: tickDiagnostic.report,
    daemon: {
      status: serviceState.status ?? "",
      pid: Number.isFinite(Number(serviceState.pid)) ? Number(serviceState.pid) : 0,
      watchScript: serviceState.watchScript ?? "",
      nextSafeTask: serviceState.nextSafeTask ?? "",
    },
    execution: assistantState.execution ?? {},
    ...(previousWatchState?.telegramPaperLoopLearningRefresh
      ? {
          telegramPaperLoopLearningRefresh: previousWatchState.telegramPaperLoopLearningRefresh,
        }
      : {}),
    files: {
      reportPath: result.report.files.reportPath,
      assistantStatePath: result.report.files.assistantStatePath,
      watchStatePath: defaultWatchStatePath(repoRoot),
      learningSnapshotPath: defaultLearningSnapshotPath(repoRoot),
      learningSummaryPath: defaultLearningSummaryPath(repoRoot),
      tickDiagnosticPath: defaultTickDiagnosticPath(repoRoot),
      startupStatePath: defaultStartupStatePath(repoRoot),
      serviceStatePath: defaultServiceStatePath(repoRoot),
    },
  };
  await writeJsonWithSha(defaultWatchStatePath(repoRoot), watchState);
  const learningSnapshot = await runAutoTradingLearningSnapshot({
    repoRoot,
    watchState,
    assistantState,
    loopState: result.report,
    snapshotPath: defaultLearningSnapshotPath(repoRoot),
  });
  const { report } = result;
  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify({ triggerPath, report, watchState, tickDiagnostic: tickDiagnostic.report, learningSnapshot: learningSnapshot.report }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `${formatRefreshLine(report, tickDiagnostic.report, triggerPath, watchState.daemon)}\n`,
    );
  }
  return {
    report,
    watchState,
    tickDiagnostic: tickDiagnostic.report,
    learningSnapshot: learningSnapshot.report,
  };
}

export async function runAutoTradingWatch(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateDir = path.resolve(options.stateDir || defaultCapitalHftStateDir());
  const debounceMs = Math.max(1, Math.floor(numberOr(options.debounceMs, DEFAULT_DEBOUNCE_MS)));
  const once = options.once === true;
  const jsonMode = options.json === true;
  const targets = watchTargets(stateDir);
  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  let shuttingDown = false;
  let running = false;
  let pendingTrigger = "";
  let pendingTimer = null;
  let latestState = null;

  const scheduleRefresh = (triggerPath) => {
    if (shuttingDown) {
      return;
    }
    pendingTrigger = triggerPath || pendingTrigger || "change";
    if (pendingTimer) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void refresh(pendingTrigger);
    }, debounceMs);
  };

  const refresh = async (triggerPath) => {
    if (shuttingDown) {
      return latestState?.report ?? null;
    }
    if (running) {
      pendingTrigger = triggerPath || pendingTrigger || "change";
      return latestState?.report ?? null;
    }
    running = true;
    try {
      latestState = await runRefresh(repoRoot, stateDir, debounceMs, jsonMode, triggerPath);
      return latestState.report;
    } catch (error) {
      process.stderr.write(
        `[auto-trading-watch] refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
      return latestState?.report ?? null;
    } finally {
      running = false;
      if (pendingTrigger && !shuttingDown) {
        const nextTrigger = pendingTrigger;
        pendingTrigger = "";
        if (!once) {
          scheduleRefresh(nextTrigger);
        }
      }
    }
  };

  watcher.on("add", scheduleRefresh);
  watcher.on("change", scheduleRefresh);
  watcher.on("unlink", scheduleRefresh);
  watcher.on("error", (error) => {
    process.stderr.write(
      `[auto-trading-watch] watcher error: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });

  const stop = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    await watcher.close().catch(() => {});
  };

  process.stdout.write(
    `[auto-trading-watch] watching ${targets.length} CapitalHftService files under ${stateDir}\n`,
  );
  await refresh("startup");

  if (once) {
    await stop();
    return latestState?.report ?? null;
  }

  return await new Promise((resolve) => {
    const finish = async () => {
      await stop();
      resolve(latestState?.report ?? null);
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    stateDir: "",
    debounceMs: undefined,
    once: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--state-dir") {
      options.stateDir = argv[++index] ?? options.stateDir;
    } else if (arg.startsWith("--state-dir=")) {
      options.stateDir = arg.slice("--state-dir=".length);
    } else if (arg === "--debounce-ms") {
      options.debounceMs = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--debounce-ms=")) {
      options.debounceMs = Number(arg.slice("--debounce-ms=".length));
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--json") {
      options.json = true;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runAutoTradingWatch(options);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `auto-trading watch failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
