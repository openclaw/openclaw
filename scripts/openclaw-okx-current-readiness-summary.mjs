import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const STATE_DIR = path.join(repoRoot, "reports", "hermes-agent", "state");
const DEFAULT_REPORT_PATH = path.join(
  STATE_DIR,
  "openclaw-okx-current-readiness-summary-latest.json",
);

const SOURCES = {
  marketSnapshot: "reports/hermes-agent/state/openclaw-okx-market-snapshot-gate-latest.json",
  marketSnapshotScheduler:
    "reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json",
  demoSimulation:
    "reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json",
  paperAuditSummary: "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
  telegramShortcuts: "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
};

const DEFAULT_SOURCE_FRESHNESS_LIMITS_MS = {
  marketSnapshot: 3 * 60 * 60 * 1000,
  marketSnapshotScheduler: 3 * 60 * 60 * 1000,
  demoSimulation: 24 * 60 * 60 * 1000,
  paperAuditSummary: 24 * 60 * 60 * 1000,
  telegramClosure: 3 * 60 * 60 * 1000,
};
const DEFAULT_SCHEDULER_NEXT_RUN_GRACE_MS = 30 * 60 * 1000;

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value, fallback = "") {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function numberValue(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolValue(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function resolveSourceFreshnessLimits(options) {
  const overrides = asRecord(options.sourceFreshnessLimitsMs);
  return Object.fromEntries(
    Object.entries(DEFAULT_SOURCE_FRESHNESS_LIMITS_MS).map(([key, fallback]) => [
      key,
      numberValue(overrides[key], fallback),
    ]),
  );
}

function ageSummary(generatedAt, now, maxAgeMs) {
  const timestamp = stringValue(generatedAt);
  if (!timestamp) {
    return {
      ok: false,
      status: "missing_generated_at",
      stale: true,
      generatedAt: "",
      ageMs: null,
      maxAgeMs,
    };
  }
  const generatedAtMs = Date.parse(timestamp);
  if (!Number.isFinite(generatedAtMs)) {
    return {
      ok: false,
      status: "invalid_generated_at",
      stale: true,
      generatedAt: timestamp,
      ageMs: null,
      maxAgeMs,
    };
  }
  const ageMs = now.getTime() - generatedAtMs;
  const ok = ageMs >= 0 && ageMs <= maxAgeMs;
  return {
    ok,
    status: ok ? "fresh" : ageMs < 0 ? "future_generated_at" : "stale",
    stale: !ok,
    generatedAt: timestamp,
    ageMs,
    maxAgeMs,
  };
}

function hasMarker(report, marker) {
  return stringList(report.markers).includes(marker);
}

async function readJsonReport(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return {
      exists: true,
      path: relativePath,
      digest: sha256Text(raw),
      report: JSON.parse(raw.replace(/^\uFEFF/u, "")),
    };
  } catch {
    return {
      exists: false,
      path: relativePath,
      digest: "",
      report: null,
    };
  }
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function summarizeMarket(source) {
  const report = asRecord(source.report);
  const coverage = asRecord(report.coverage);
  const instTypes = stringList(coverage.instTypes);
  const markers = stringList(report.markers);
  const ok =
    source.exists &&
    stringValue(report.status) === "all_market_snapshots_ok" &&
    ["spot_snapshot_ok", "swap_snapshot_ok", "futures_snapshot_ok", "option_snapshot_ok"].every(
      (marker) => markers.includes(marker),
    ) &&
    boolValue(coverage.snapshotOnly) &&
    !boolValue(coverage.continuousStreamingEnabled);
  return {
    ok,
    status: stringValue(report.status, source.exists ? "unknown" : "missing"),
    generatedAt: stringValue(report.generatedAt),
    instTypes,
    totalListedCount: numberValue(coverage.totalListedCount),
    totalWithLastPriceCount: numberValue(coverage.totalWithLastPriceCount),
    snapshotOnly: boolValue(coverage.snapshotOnly),
    continuousStreamingEnabled: boolValue(coverage.continuousStreamingEnabled),
    markers,
    sourcePath: source.path,
    sourceDigest: source.digest,
  };
}

function summarizeMarketSnapshotScheduler(source, now, options = {}) {
  const report = asRecord(source.report);
  const schedule = asRecord(report.schedule);
  const safety = asRecord(report.safety);
  const everyMs = numberValue(schedule.everyMs);
  const nextRunAt = stringValue(schedule.nextRunAt);
  const nextRunAtMsFromIso = Date.parse(nextRunAt);
  const nextRunAtMs = numberValue(
    schedule.nextRunAtMs,
    Number.isFinite(nextRunAtMsFromIso) ? nextRunAtMsFromIso : 0,
  );
  const nextRunGraceMs = Math.max(
    numberValue(options.schedulerNextRunGraceMs, DEFAULT_SCHEDULER_NEXT_RUN_GRACE_MS),
    everyMs > 0 ? everyMs * 6 : DEFAULT_SCHEDULER_NEXT_RUN_GRACE_MS,
  );
  const nextRunLagMs = nextRunAtMs > 0 ? now.getTime() - nextRunAtMs : null;
  const nextRunWithinGrace = typeof nextRunLagMs === "number" && nextRunLagMs <= nextRunGraceMs;
  const machineLine = stringValue(report.machineLine);
  const ok =
    source.exists &&
    stringValue(report.status) === "passed" &&
    everyMs === 5 * 60 * 1000 &&
    stringValue(schedule.entrypoint) === "pnpm okx:market-snapshot" &&
    stringValue(schedule.checkEntrypoint) === "pnpm okx:market-snapshot:check" &&
    boolValue(safety.readOnly) &&
    boolValue(safety.publicMarketDataOnly) &&
    !boolValue(safety.privateOrderQueryEnabled) &&
    !boolValue(safety.orderPlacementEnabled) &&
    !boolValue(safety.cancelOrderEnabled) &&
    !boolValue(safety.liveTradingEnabled) &&
    !boolValue(safety.writeTradingEnabled) &&
    boolValue(safety.noOrderWrite) &&
    machineLine.includes("okxMarketSnapshotScheduler=pass") &&
    machineLine.includes(`nextRunAt=${nextRunAt}`) &&
    machineLine.includes("noOrderWrite=true") &&
    nextRunWithinGrace;
  return {
    ok,
    status: stringValue(report.status, source.exists ? "unknown" : "missing"),
    generatedAt: stringValue(report.generatedAt),
    jobId: stringValue(schedule.jobId),
    everyMs,
    entrypoint: stringValue(schedule.entrypoint),
    checkEntrypoint: stringValue(schedule.checkEntrypoint),
    nextRunAt,
    nextRunAtMs,
    nextRunLagMs,
    nextRunGraceMs,
    nextRunWithinGrace,
    readOnly: boolValue(safety.readOnly),
    publicMarketDataOnly: boolValue(safety.publicMarketDataOnly),
    privateOrderQueryEnabled: boolValue(safety.privateOrderQueryEnabled),
    orderPlacementEnabled: boolValue(safety.orderPlacementEnabled),
    cancelOrderEnabled: boolValue(safety.cancelOrderEnabled),
    liveTradingEnabled: boolValue(safety.liveTradingEnabled),
    writeTradingEnabled: boolValue(safety.writeTradingEnabled),
    noOrderWrite: boolValue(safety.noOrderWrite),
    machineLine,
    sourcePath: source.path,
    sourceDigest: source.digest,
  };
}

function summarizeDemoSimulation(source) {
  const report = asRecord(source.report);
  const result = asRecord(report.result);
  const safety = asRecord(report.safety);
  const ok =
    source.exists &&
    stringValue(report.status) === "ready_no_exchange_write" &&
    stringValue(report.code) === "demo_order_simulation_result_ready" &&
    hasMarker(report, "demo_simulation_no_exchange_write") &&
    !boolValue(safety.submittedOrder) &&
    !boolValue(safety.exchangeWriteAttempted) &&
    !boolValue(safety.orderStatusQueryExecuted) &&
    !boolValue(safety.cancelSubmitted);
  return {
    ok,
    status: stringValue(report.status, source.exists ? "unknown" : "missing"),
    code: stringValue(report.code, source.exists ? "unknown" : "missing"),
    generatedAt: stringValue(report.generatedAt),
    instId: stringValue(result.instId),
    simulationCode: stringValue(result.simulationCode),
    simulationStatus: stringValue(result.simulationStatus),
    submittedOrder: boolValue(safety.submittedOrder),
    exchangeWriteAttempted: boolValue(safety.exchangeWriteAttempted),
    orderStatusQueryExecuted: boolValue(safety.orderStatusQueryExecuted),
    cancelSubmitted: boolValue(safety.cancelSubmitted),
    sourcePath: source.path,
    sourceDigest: source.digest,
  };
}

function summarizePaperAudit(source) {
  const report = asRecord(source.report);
  const counts = asRecord(report.counts);
  const safetyAggregate = asRecord(report.safetyAggregate);
  const ok =
    source.exists &&
    stringValue(report.status) === "ready_read_only" &&
    stringValue(report.code) === "paper_audit_summary_ready" &&
    boolValue(safetyAggregate.allEntriesSafe) &&
    numberValue(safetyAggregate.submittedOrder) === 0 &&
    numberValue(safetyAggregate.exchangeWriteAttempted) === 0 &&
    numberValue(safetyAggregate.orderStatusQueryExecuted) === 0 &&
    numberValue(safetyAggregate.cancelSubmitted) === 0;
  return {
    ok,
    status: stringValue(report.status, source.exists ? "unknown" : "missing"),
    code: stringValue(report.code, source.exists ? "unknown" : "missing"),
    generatedAt: stringValue(report.generatedAt),
    entries: numberValue(counts.totalEntries),
    allEntriesSafe: boolValue(safetyAggregate.allEntriesSafe),
    submittedOrder: numberValue(safetyAggregate.submittedOrder),
    exchangeWriteAttempted: numberValue(safetyAggregate.exchangeWriteAttempted),
    orderStatusQueryExecuted: numberValue(safetyAggregate.orderStatusQueryExecuted),
    cancelSubmitted: numberValue(safetyAggregate.cancelSubmitted),
    sourcePath: source.path,
    sourceDigest: source.digest,
  };
}

function summarizeTelegramClosure(source) {
  const report = asRecord(source.report);
  const summary = asRecord(report.summary);
  const closure = asRecord(summary.okxPaperAuditClosure);
  const machineLine = stringValue(closure.machineLine);
  const ok =
    source.exists &&
    stringValue(closure.status) === "pass" &&
    boolValue(closure.platformSnapshotRead) &&
    boolValue(closure.platformVisible) &&
    boolValue(closure.okxStatusRead) &&
    boolValue(closure.okxStatusVisible) &&
    boolValue(closure.noOrderWrite) &&
    machineLine.includes("noOrderWrite=true");
  return {
    ok,
    status: stringValue(closure.status, source.exists ? "unknown" : "missing"),
    generatedAt: stringValue(report.generatedAt),
    platformSnapshotRead: boolValue(closure.platformSnapshotRead),
    platformVisible: boolValue(closure.platformVisible),
    okxStatusRead: boolValue(closure.okxStatusRead),
    okxStatusVisible: boolValue(closure.okxStatusVisible),
    noOrderWrite: boolValue(closure.noOrderWrite),
    machineLine,
    sourcePath: source.path,
    sourceDigest: source.digest,
  };
}

function summarizeSourceFreshness(readiness, now, limits) {
  const marketSnapshot = ageSummary(
    readiness.marketSnapshot.generatedAt,
    now,
    limits.marketSnapshot,
  );
  const marketSnapshotScheduler = ageSummary(
    readiness.marketSnapshotScheduler.generatedAt,
    now,
    limits.marketSnapshotScheduler,
  );
  const demoSimulation = ageSummary(
    readiness.demoSimulation.generatedAt,
    now,
    limits.demoSimulation,
  );
  const paperAuditSummary = ageSummary(
    readiness.paperAuditSummary.generatedAt,
    now,
    limits.paperAuditSummary,
  );
  const telegramClosure = ageSummary(
    readiness.telegramClosure.generatedAt,
    now,
    limits.telegramClosure,
  );
  const ok = [
    marketSnapshot,
    marketSnapshotScheduler,
    demoSimulation,
    paperAuditSummary,
    telegramClosure,
  ].every((entry) => entry.ok);
  return {
    ok,
    checkedAt: now.toISOString(),
    marketSnapshot,
    marketSnapshotScheduler,
    demoSimulation,
    paperAuditSummary,
    telegramClosure,
  };
}

function collectBlockers(summary, sourceFreshness) {
  const blockers = [];
  if (!summary.marketSnapshot.ok) {
    blockers.push("market_snapshot_not_ready");
  }
  if (!summary.marketSnapshotScheduler.ok) {
    blockers.push("market_snapshot_scheduler_not_ready");
  }
  if (!summary.demoSimulation.ok) {
    blockers.push("demo_simulation_not_ready");
  }
  if (!summary.paperAuditSummary.ok) {
    blockers.push("paper_audit_summary_not_ready");
  }
  if (!summary.telegramClosure.ok) {
    blockers.push("telegram_closure_not_ready");
  }
  if (sourceFreshness.marketSnapshot.stale) {
    blockers.push("market_snapshot_stale");
  }
  if (sourceFreshness.marketSnapshotScheduler.stale) {
    blockers.push("market_snapshot_scheduler_stale");
  }
  if (!summary.marketSnapshotScheduler.nextRunWithinGrace) {
    blockers.push("market_snapshot_scheduler_next_run_stale");
  }
  if (sourceFreshness.demoSimulation.stale) {
    blockers.push("demo_simulation_stale");
  }
  if (sourceFreshness.paperAuditSummary.stale) {
    blockers.push("paper_audit_summary_stale");
  }
  if (sourceFreshness.telegramClosure.stale) {
    blockers.push("telegram_closure_stale");
  }
  return blockers;
}

export async function buildOkxCurrentReadinessSummary(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const generatedAt = now.toISOString();
  const sourceFreshnessLimitsMs = resolveSourceFreshnessLimits(options);
  const sources = {
    marketSnapshot: await readJsonReport(SOURCES.marketSnapshot),
    marketSnapshotScheduler: await readJsonReport(SOURCES.marketSnapshotScheduler),
    demoSimulation: await readJsonReport(SOURCES.demoSimulation),
    paperAuditSummary: await readJsonReport(SOURCES.paperAuditSummary),
    telegramShortcuts: await readJsonReport(SOURCES.telegramShortcuts),
  };
  const readiness = {
    marketSnapshot: summarizeMarket(sources.marketSnapshot),
    marketSnapshotScheduler: summarizeMarketSnapshotScheduler(
      sources.marketSnapshotScheduler,
      now,
      options,
    ),
    demoSimulation: summarizeDemoSimulation(sources.demoSimulation),
    paperAuditSummary: summarizePaperAudit(sources.paperAuditSummary),
    telegramClosure: summarizeTelegramClosure(sources.telegramShortcuts),
  };
  const sourceFreshness = summarizeSourceFreshness(readiness, now, sourceFreshnessLimitsMs);
  const blockers = collectBlockers(readiness, sourceFreshness);
  const ready = blockers.length === 0;
  const machineLine = [
    `okxCurrentReadiness=${ready ? "ready" : "blocked"}`,
    `quote=${readiness.marketSnapshot.ok ? "ok" : "blocked"}`,
    `scheduler=${readiness.marketSnapshotScheduler.ok ? "pass" : "blocked"}`,
    `schedulerNextRunAt=${readiness.marketSnapshotScheduler.nextRunAt || "unavailable"}`,
    `demo=${readiness.demoSimulation.status}`,
    `paperAudit=${readiness.paperAuditSummary.status}`,
    `telegram=${readiness.telegramClosure.status}`,
    `freshness=${sourceFreshness.ok ? "ok" : "stale"}`,
    `noOrderWrite=${
      ready &&
      readiness.telegramClosure.noOrderWrite &&
      readiness.marketSnapshotScheduler.noOrderWrite
    }`,
  ].join(" ");

  return {
    schema: "openclaw.okx.current-readiness-summary.v1",
    generatedAt,
    provider: "okx",
    language: "zh-TW",
    mode: "read_only_current_readiness_summary",
    status: ready ? "ready_read_only" : "blocked",
    code: ready ? "okx_current_readiness_ready" : "okx_current_readiness_blocked",
    summary_zh_tw: ready
      ? "OKX current-readiness 可讀：報價、scheduler、demo simulation、paper audit、Telegram closure 與來源新鮮度全部通過，noOrderWrite=true。"
      : `OKX current-readiness 阻擋：${blockers.join("、")}。`,
    blockers,
    markers: [
      ready ? "okx_current_readiness_ready" : "okx_current_readiness_blocked",
      readiness.marketSnapshot.ok ? "quote_snapshot_ok" : "quote_snapshot_blocked",
      readiness.marketSnapshotScheduler.ok
        ? "market_snapshot_scheduler_ready"
        : "market_snapshot_scheduler_blocked",
      readiness.demoSimulation.ok ? "demo_simulation_ready" : "demo_simulation_blocked",
      readiness.paperAuditSummary.ok ? "paper_audit_summary_ready" : "paper_audit_summary_blocked",
      readiness.telegramClosure.ok ? "telegram_closure_ready" : "telegram_closure_blocked",
      sourceFreshness.ok ? "source_freshness_ok" : "source_freshness_stale",
      sourceFreshness.marketSnapshot.ok ? "market_snapshot_fresh" : "market_snapshot_stale",
      sourceFreshness.marketSnapshotScheduler.ok
        ? "market_snapshot_scheduler_fresh"
        : "market_snapshot_scheduler_stale",
      readiness.marketSnapshotScheduler.nextRunWithinGrace
        ? "market_snapshot_scheduler_next_run_current"
        : "market_snapshot_scheduler_next_run_stale",
      sourceFreshness.demoSimulation.ok ? "demo_simulation_fresh" : "demo_simulation_stale",
      sourceFreshness.paperAuditSummary.ok
        ? "paper_audit_summary_fresh"
        : "paper_audit_summary_stale",
      sourceFreshness.telegramClosure.ok ? "telegram_closure_fresh" : "telegram_closure_stale",
      "read_only_current_summary",
      "submitted_order_false",
      "exchange_write_false",
      "order_status_query_false",
      "cancel_submitted_false",
    ],
    machineLine,
    readiness,
    sourceFreshness,
    safety: {
      readOnly: true,
      summaryOnly: true,
      paperOnly: true,
      demoOnly: true,
      sourceFreshnessChecked: true,
      executionAllowed: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      orderPlacementEnabled: false,
      submittedOrder: false,
      exchangeWriteAttempted: false,
      orderStatusQueryExecuted: false,
      cancelOrderEnabled: false,
      cancelSubmitted: false,
      exchangeCancelAttempted: false,
      withdrawalEnabled: false,
      noOrderWrite:
        ready &&
        readiness.telegramClosure.noOrderWrite &&
        readiness.marketSnapshotScheduler.noOrderWrite,
    },
    readTargets: {
      marketSnapshot: SOURCES.marketSnapshot,
      marketSnapshotScheduler: SOURCES.marketSnapshotScheduler,
      demoSimulation: SOURCES.demoSimulation,
      paperAuditSummary: SOURCES.paperAuditSummary,
      telegramShortcuts: SOURCES.telegramShortcuts,
    },
    commands: {
      executed: [
        "read local OpenClaw OKX market snapshot report",
        "read local OpenClaw OKX market snapshot scheduler report",
        "read local OpenClaw OKX demo simulation result report",
        "read local OpenClaw OKX paper audit summary report",
        "read local OpenClaw Telegram trading shortcuts report",
      ],
      notExecuted: [
        "GET /api/v5/trade/order",
        "GET /api/v5/trade/orders-pending",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
      ],
      forbidden: [
        "okx spot place",
        "okx swap place",
        "okx futures place",
        "okx spot cancel",
        "okx swap cancel",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
      ],
    },
    rollbackPath: [
      "Remove package scripts okx:current-readiness and okx:current-readiness:check.",
      "Delete scripts/openclaw-okx-current-readiness-summary.mjs and scripts/check-openclaw-okx-current-readiness-summary.mjs.",
      "Delete reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json and .sha256.",
      "Remove OKX current-readiness references from skills/openclaw-okx-cex-status/SKILL.md and docs/automation/module-skill-inventory.md.",
    ],
    nextSafeTask:
      "把 OKX refresh workflow 的 schedulerNextRunAt 證據接到 Telegram/heartbeat 操作入口；仍保持 noOrderWrite=true。",
  };
}

async function main() {
  const reportPath = path.resolve(argValue("--out", DEFAULT_REPORT_PATH));
  const report = await buildOkxCurrentReadinessSummary();
  if (hasFlag("--write-state")) {
    await writeJsonWithHash(reportPath, report);
  }
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "OKX_CURRENT_READINESS_SUMMARY",
      `status=${report.status}`,
      `code=${report.code}`,
      `machineLine=${report.machineLine}`,
      `blockers=${report.blockers.join("/")}`,
      `report=${repoRelative(reportPath)}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] === currentFile) {
  await main();
}
