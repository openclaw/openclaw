import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function defaultLearningSnapshotPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "auto-trading-learning-snapshot.json");
}

function defaultLearningSummaryPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "auto-trading-learning-summary.md");
}

function defaultLoopStreamPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-automation-loops.jsonl");
}

function defaultDaemonStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "service", "auto-trading-watch-service.json");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJson(filePath, label) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`, { cause: error });
    }
    throw new Error(
      `Invalid ${label} JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeTextWithSha(filePath, text) {
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, normalized, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(normalized)}\n`, "ascii");
}

function bool(value) {
  return value === true;
}

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(
            `Invalid JSONL line ${index + 1} in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function buildHistorySummary(records, loopState, streamPath) {
  const recent = records.slice(-10);
  const recentStatuses = recent.map((record) => String(record?.status ?? ""));
  const recentReadinessStatuses = recent.map((record) => String(record?.readiness?.status ?? ""));
  const recentPaperIntentFlags = recent.map(
    (record) => record?.trading?.paperIntentCreated === true,
  );
  const tailStatus = String(loopState?.status ?? recent.at(-1)?.status ?? "");
  let currentStatusStreak = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (String(records[index]?.status ?? "") !== tailStatus) {
      break;
    }
    currentStatusStreak += 1;
  }
  const paperIntentCount = records.reduce(
    (count, record) => count + (record?.trading?.paperIntentCreated === true ? 1 : 0),
    0,
  );
  const blockedReadinessCount = records.reduce(
    (count, record) => count + (String(record?.status ?? "") === "blocked_readiness" ? 1 : 0),
    0,
  );
  return {
    streamPath,
    totalRecords: records.length,
    recentWindowSize: recent.length,
    recentStatuses,
    recentReadinessStatuses,
    recentPaperIntentFlags,
    lastStatus: tailStatus,
    currentStatusStreak,
    paperIntentCount,
    blockedReadinessCount,
    dominantStatus: tailStatus,
  };
}

function deriveBlockerFocus(watchState, assistantState, loopState) {
  const blockers = new Set([
    ...(assistantState?.quote?.diagnostics?.blockers ?? []),
    ...(watchState?.assistant?.nextSafeTask ? [] : ["missing_next_safe_task"]),
  ]);
  if (blockers.has("freshness_stale") || blockers.has("blocked_quote_stale")) {
    return "freshness_recovery";
  }
  if (blockers.has("bid_ask_not_usable")) {
    return "bid_ask_recovery";
  }
  if (loopState?.status === "blocked_readiness") {
    return "readiness_recovery";
  }
  return "paper_only_observation";
}

function renderLearningSummary(report) {
  const recentStatuses = Array.isArray(report?.history?.recentStatuses)
    ? report.history.recentStatuses
    : [];
  const recentReadinessStatuses = Array.isArray(report?.history?.recentReadinessStatuses)
    ? report.history.recentReadinessStatuses
    : [];
  const blockers = Array.isArray(report?.evolution?.blockers) ? report.evolution.blockers : [];
  const files = report?.files ?? {};
  return [
    "# OpenClaw 類高頻自動交易學習摘要",
    "",
    `- status: \`${report?.status ?? ""}\``,
    `- blockerFocus: \`${report?.evolution?.blockerFocus ?? ""}\``,
    `- quoteFreshnessStatus: \`${report?.evolution?.quoteFreshnessStatus ?? ""}\``,
    `- bidAskUsable: \`${report?.evolution?.bidAskUsable === true}\``,
    `- paperIntents: \`${report?.evolution?.paperIntents ?? 0}\``,
    `- paperEligible: \`${report?.evolution?.paperEligible === true}\``,
    `- fastOrderPaperPattern: \`${report?.assistant?.fastOrderPaperPattern ?? ""}\``,
    `- fastOrderPaperSuccessCount: \`${report?.assistant?.fastOrderPaperSuccessCount ?? 0}\``,
    `- fastOrderPaperFailureCount: \`${report?.assistant?.fastOrderPaperFailureCount ?? 0}\``,
    `- latestFastOrderStatus: \`${report?.assistant?.latestFastOrderStatus ?? ""}\``,
    `- fastOrderBrokerCommandEnabled: \`${report?.fastOrderPaperPattern?.brokerCommandEnabled === true}\``,
    `- fastOrderSentBrokerOrder: \`${report?.fastOrderPaperPattern?.sentBrokerOrder === true}\``,
    `- promoted: \`${report?.evolution?.promoted === true}\``,
    `- executionStatus: \`${report?.execution?.status ?? ""}\``,
    `- entrySide: \`${report?.execution?.entry?.side ?? ""}\``,
    `- entryStyle: \`${report?.execution?.entry?.style ?? ""}\``,
    `- entryAction: \`${report?.execution?.entry?.action ?? ""}\``,
    `- exitSide: \`${report?.execution?.exit?.side ?? ""}\``,
    `- exitStyle: \`${report?.execution?.exit?.style ?? ""}\``,
    `- exitAction: \`${report?.execution?.exit?.action ?? ""}\``,
    `- actionSummary: ${report?.execution?.actionSummary ?? ""}`,
    `- tickDiagnosticStatus: \`${report?.tickDiagnostic?.status ?? ""}\``,
    `- tickMonitorRunning: \`${report?.tickDiagnostic?.tick?.monitorRunning === true}\``,
    `- tickRealtimeRunning: \`${report?.tickDiagnostic?.tick?.realtimeRunning === true}\``,
    `- tickLatestCallbackAt: \`${report?.tickDiagnostic?.latestCallback?.receivedAt ?? ""}\``,
    "- daemonStatus: " + (report?.daemon?.status ?? ""),
    "- daemonPid: " + (report?.daemon?.pid ?? 0),
    "- daemonWatchScript: " + (report?.daemon?.watchScript ?? ""),
    "- daemonNextSafeTask: " + (report?.daemon?.nextSafeTask ?? ""),
    "- collaborationActors: " +
      (Array.isArray(report?.collaboration?.actors) ? report.collaboration.actors.join(",") : ""),
    "- collaborationLearningMode: " + (report?.collaboration?.learningMode ?? ""),
    "- collaborationSafetyBoundary: " + (report?.collaboration?.safetyBoundary ?? ""),
    `- nextSafeTask: ${report?.recommendation?.nextSafeTask ?? ""}`,
    "",
    "## 最近狀態",
    recentStatuses.length > 0
      ? recentStatuses.map((status, index) => `- [${index + 1}] \`${status}\``).join("\n")
      : "- (empty)",
    "",
    "## 最近 readiness",
    recentReadinessStatuses.length > 0
      ? recentReadinessStatuses.map((status, index) => `- [${index + 1}] \`${status}\``).join("\n")
      : "- (empty)",
    "",
    "## Blockers",
    blockers.length > 0 ? blockers.map((item) => `- \`${item}\``).join("\n") : "- (empty)",
    "",
    "## Files",
    `- watchStatePath: \`${files.watchStatePath ?? ""}\``,
    `- assistantStatePath: \`${files.assistantStatePath ?? ""}\``,
    `- loopReportPath: \`${files.loopReportPath ?? ""}\``,
    `- snapshotPath: \`${files.snapshotPath ?? ""}\``,
    `- summaryPath: \`${files.summaryPath ?? ""}\``,
  ].join("\n");
}

export function buildAutoTradingLearningSnapshot({
  watchState,
  assistantState,
  loopState,
  daemonState,
  history,
  repoRoot,
  watchStatePath,
  assistantStatePath,
  loopReportPath,
  snapshotPath,
  serviceStatePath,
}) {
  const blockers = Array.isArray(assistantState?.quote?.diagnostics?.blockers)
    ? assistantState.quote.diagnostics.blockers
    : [];
  const quote = assistantState?.quote ?? {};
  const summary = assistantState?.summary ?? {};
  const rawFastOrderPaperPattern =
    assistantState?.fastOrderPaperPattern &&
    typeof assistantState.fastOrderPaperPattern === "object"
      ? assistantState.fastOrderPaperPattern
      : {};
  const fastOrderPaperPattern = {
    ...rawFastOrderPaperPattern,
    pattern: stringOr(
      rawFastOrderPaperPattern.pattern,
      stringOr(summary.fastOrderPaperPattern, "no-paper-execution"),
    ),
    successCount: numberOr(
      rawFastOrderPaperPattern.successCount,
      numberOr(summary.fastOrderPaperSuccessCount, 0),
    ),
    failureCount: numberOr(
      rawFastOrderPaperPattern.failureCount,
      numberOr(summary.fastOrderPaperFailureCount, 0),
    ),
    latestStatus: stringOr(
      rawFastOrderPaperPattern.latestStatus,
      stringOr(summary.latestFastOrderStatus, "none"),
    ),
    brokerCommandEnabled: false,
    sentBrokerOrder: false,
    submissionCommand: "",
  };
  const tickDiagnostic = watchState?.tickDiagnostic ?? {};
  const nextSafeTask =
    assistantState?.recommendation?.nextSafeTask ||
    watchState?.assistant?.nextSafeTask ||
    loopState?.nextSafeTask ||
    "等待新的 SKQuoteLib quote callback，再重跑 paper loop。";

  return {
    schema: "openclaw.capital.auto-trading-learning-snapshot.v1",
    generatedAt: new Date().toISOString(),
    repoRoot,
    provider: "capital",
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    hftLikeAutomation: true,
    status: assistantState?.status ?? loopState?.status ?? "unknown",
    assistant: {
      name: assistantState?.assistant?.name ?? "類高頻自動交易助手",
      status: assistantState?.status ?? "",
      fastOrderPaperPattern: fastOrderPaperPattern.pattern,
      fastOrderPaperSuccessCount: fastOrderPaperPattern.successCount,
      fastOrderPaperFailureCount: fastOrderPaperPattern.failureCount,
      latestFastOrderStatus: fastOrderPaperPattern.latestStatus,
      nextSafeTask,
    },
    watch: {
      triggerPath: watchState?.triggerPath ?? "startup",
      stateDir: watchState?.stateDir ?? "",
      status: watchState?.status ?? "",
      targets: Array.isArray(watchState?.watch?.targets) ? watchState.watch.targets : [],
    },
    loop: {
      status: loopState?.status ?? watchState?.loop?.status ?? "",
      pumpStatus: watchState?.loop?.pumpStatus ?? "",
      readinessStatus: watchState?.loop?.readinessStatus ?? "",
      paperIntentCreated: watchState?.loop?.paperIntentCreated === true,
      learningStatus: watchState?.loop?.learningStatus ?? "",
      paperEligible: watchState?.loop?.paperEligible === true,
      liveEligible: watchState?.loop?.liveEligible === true,
    },
    tickDiagnostic: {
      status: stringOr(tickDiagnostic?.status, ""),
      monitorRunning: bool(tickDiagnostic?.tick?.monitorRunning),
      realtimeRunning: bool(tickDiagnostic?.tick?.realtimeRunning),
      latestCallbackAt: stringOr(tickDiagnostic?.latestCallback?.receivedAt, ""),
      latestCallbackSource: stringOr(tickDiagnostic?.latestCallback?.eventSource, ""),
      latestCallbackBid: stringOr(tickDiagnostic?.latestCallback?.bid, ""),
      latestCallbackAsk: stringOr(tickDiagnostic?.latestCallback?.ask, ""),
      nextSafeTask: stringOr(tickDiagnostic?.recommendation?.nextSafeTask, ""),
    },
    daemon: {
      status: stringOr(daemonState?.status, ""),
      pid: Number.isFinite(Number(daemonState?.pid)) ? Number(daemonState.pid) : 0,
      watchScript: stringOr(daemonState?.watchScript, ""),
      nextSafeTask: stringOr(daemonState?.nextSafeTask, ""),
    },
    collaboration: {
      actors: ["openclaw", "claude", "codex"],
      learningMode: "heartbeat_snapshot_feedback",
      memoryFeedbackTarget: "openclaw.auto_trading.learning_snapshot",
      safetyBoundary: "paper_only_until_live_gates_pass",
      appliedLearning:
        "Record automation outcomes, blockers, and next safe task for future OpenClaw/Claude/Codex coordination.",
    },
    evolution: {
      blockerFocus: deriveBlockerFocus(watchState, assistantState, loopState),
      blockers,
      quoteFreshnessStatus: quote.freshnessStatus ?? quote.status ?? "",
      bidAskUsable: quote.diagnostics?.bidAskUsable === true,
      quoteAgeSeconds: summary.quoteAgeSeconds ?? -1,
      consecutiveReadinessBlocks: summary.consecutiveReadinessBlocks ?? 0,
      consecutiveReadyCycles: summary.consecutiveReadyCycles ?? 0,
      paperIntents: summary.paperIntents ?? 0,
      paperEligible: summary.paperEligible === true,
      fastOrderPaperPattern: fastOrderPaperPattern.pattern,
      fastOrderPaperSuccessCount: fastOrderPaperPattern.successCount,
      fastOrderPaperFailureCount: fastOrderPaperPattern.failureCount,
      latestFastOrderStatus: fastOrderPaperPattern.latestStatus,
      promoted: assistantState?.promotion?.promoted === true,
    },
    fastOrderPaperPattern,
    execution: assistantState?.execution ?? {},
    history,
    files: {
      watchStatePath,
      assistantStatePath,
      loopReportPath,
      snapshotPath,
      serviceStatePath,
    },
    recommendation: {
      nextSafeTask,
    },
  };
}

export async function runAutoTradingLearningSnapshot(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const snapshotPath = path.resolve(options.snapshotPath || defaultLearningSnapshotPath(repoRoot));
  const summaryPath = defaultLearningSummaryPath(repoRoot);
  const watchStatePath = path.join(repoRoot, ".openclaw", "ui", "auto-trading-watch-state.json");
  const assistantStatePath = path.join(
    repoRoot,
    ".openclaw",
    "ui",
    "capital-paper-assistant-state.json",
  );
  const loopReportPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-paper-automation-loop-latest.json",
  );
  const watchState =
    options.watchState ?? (await readJson(watchStatePath, "auto trading watch state"));
  const assistantState =
    options.assistantState ?? (await readJson(assistantStatePath, "canonical assistant state"));
  const loopState = options.loopState ?? (await readJson(loopReportPath, "loop state"));
  const daemonStatePath = defaultDaemonStatePath(repoRoot);
  const daemonState =
    options.daemonState ?? (await readJson(daemonStatePath, "auto trading watch daemon state"));
  const loopStreamPath = defaultLoopStreamPath(repoRoot);
  const loopRecords = options.loopRecords ?? (await readJsonLines(loopStreamPath));
  const report = buildAutoTradingLearningSnapshot({
    watchState,
    assistantState,
    loopState,
    daemonState,
    history: buildHistorySummary(loopRecords, loopState, loopStreamPath),
    repoRoot,
    watchStatePath,
    assistantStatePath,
    loopReportPath,
    snapshotPath,
    serviceStatePath: daemonStatePath,
  });
  report.files.summaryPath = summaryPath;
  if (options.writeState !== false) {
    await writeJsonWithSha(snapshotPath, report);
    const summaryText = renderLearningSummary({
      ...report,
      files: {
        ...report.files,
      },
    });
    await writeTextWithSha(summaryPath, summaryText);
  }
  return {
    report,
    files: {
      snapshotPath,
      summaryPath: defaultLearningSummaryPath(repoRoot),
      watchStatePath,
      assistantStatePath,
      loopReportPath,
      serviceStatePath: daemonStatePath,
    },
  };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    snapshotPath: "",
    writeState: true,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--snapshot") {
      options.snapshotPath = argv[++index] ?? options.snapshotPath;
    } else if (arg.startsWith("--snapshot=")) {
      options.snapshotPath = arg.slice("--snapshot=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--read-only") {
      options.writeState = false;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runAutoTradingLearningSnapshot(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw auto-trading learning snapshot",
        `status=${result.report.status}`,
        `blockerFocus=${result.report.evolution.blockerFocus}`,
        `historyWindow=${result.report.history?.recentWindowSize ?? 0}`,
        `nextSafeTask=${result.report.recommendation.nextSafeTask}`,
        `snapshot=${result.files.snapshotPath}`,
      ].join("\n") + "\n",
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `auto-trading learning snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
