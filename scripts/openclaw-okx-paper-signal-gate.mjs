import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOkxApiStatusGate } from "./openclaw-okx-api-status-gate.mjs";
import { runOkxMarketSnapshotLoop } from "./openclaw-okx-market-snapshot-loop.mjs";
import { buildOkxOrderProposalGate } from "./openclaw-okx-order-proposal-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const STATE_DIR = path.join(repoRoot, "reports", "hermes-agent", "state");
const DEFAULT_REPORT_PATH = path.join(STATE_DIR, "openclaw-okx-paper-signal-gate-latest.json");
const LOOP_REPORT_PATH = path.join(STATE_DIR, "openclaw-okx-market-snapshot-loop-latest.json");
const LOOP_WARMUP_LOCK_PATH = path.join(
  STATE_DIR,
  "openclaw-okx-market-snapshot-loop.paper-signal.lock.json",
);
const DEFAULT_STALE_THRESHOLD_MS = 3000;
const POLICY_WARNINGS = [
  "chat_supplied_secret_must_rotate",
  "withdraw_permission_blocked",
  "blank_ip_with_trade_or_withdraw_blocked",
];

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function roundNumber(value, digits = 4) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toFiniteNumber(value) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function buildPolicyWarnings({ apiStatus, orderProposal }) {
  const warnings = [];
  for (const marker of POLICY_WARNINGS) {
    if (apiStatus.markers?.includes(marker) || orderProposal.markers?.includes(marker)) {
      warnings.push(marker);
    }
  }
  return [...new Set(warnings)];
}

function calculateCandidateSignal(instType, ticker) {
  const last = toFiniteNumber(ticker.last);
  const bidPx = toFiniteNumber(ticker.bidPx);
  const askPx = toFiniteNumber(ticker.askPx);
  const open24h = toFiniteNumber(ticker.open24h);
  const volCcy24h = toFiniteNumber(ticker.volCcy24h);
  const high24h = toFiniteNumber(ticker.high24h);
  const low24h = toFiniteNumber(ticker.low24h);
  const hasQuote = Number.isFinite(last) && Number.isFinite(bidPx) && Number.isFinite(askPx);
  const midPx = hasQuote ? (bidPx + askPx) / 2 : NaN;
  const spreadPct = hasQuote && midPx > 0 ? ((askPx - bidPx) / midPx) * 100 : NaN;
  const change24hPct =
    Number.isFinite(last) && Number.isFinite(open24h) && open24h > 0
      ? ((last - open24h) / open24h) * 100
      : NaN;
  const range24hPct =
    Number.isFinite(high24h) && Number.isFinite(low24h) && low24h > 0
      ? ((high24h - low24h) / low24h) * 100
      : NaN;

  let score = 50;
  if (Number.isFinite(spreadPct)) {
    if (spreadPct <= 0.08) {
      score += 20;
    } else if (spreadPct <= 0.2) {
      score += 10;
    } else if (spreadPct > 0.35) {
      score -= 20;
    } else if (spreadPct > 0.25) {
      score -= 10;
    }
  } else {
    score -= 10;
  }
  if (Number.isFinite(change24hPct)) {
    if (change24hPct >= 2) {
      score += 20;
    } else if (change24hPct >= 0.5) {
      score += 10;
    } else if (change24hPct <= -2) {
      score -= 20;
    } else if (change24hPct <= -0.5) {
      score -= 10;
    }
  }
  if (Number.isFinite(volCcy24h)) {
    if (volCcy24h >= 10_000_000) {
      score += 10;
    } else if (volCcy24h >= 1_000_000) {
      score += 5;
    }
  }
  if (hasQuote) {
    score += 5;
  } else {
    score -= 25;
  }
  const normalizedScore = clampScore(score);
  const signal =
    normalizedScore >= 70
      ? "paper_long_candidate"
      : normalizedScore <= 30
        ? "paper_short_candidate"
        : "paper_neutral_watch";
  return {
    instType,
    instId: String(ticker.instId || ""),
    signal,
    score: normalizedScore,
    metrics: {
      last: Number.isFinite(last) ? roundNumber(last, 8) : 0,
      bidPx: Number.isFinite(bidPx) ? roundNumber(bidPx, 8) : 0,
      askPx: Number.isFinite(askPx) ? roundNumber(askPx, 8) : 0,
      spreadPct: Number.isFinite(spreadPct) ? roundNumber(spreadPct, 4) : 0,
      change24hPct: Number.isFinite(change24hPct) ? roundNumber(change24hPct, 4) : 0,
      range24hPct: Number.isFinite(range24hPct) ? roundNumber(range24hPct, 4) : 0,
      volCcy24h: Number.isFinite(volCcy24h) ? roundNumber(volCcy24h, 2) : 0,
    },
  };
}

function extractSignalCandidates(loopReport) {
  const latestTick = loopReport?.latestTick;
  const candidates = [];
  if (!latestTick || !Array.isArray(latestTick.snapshots)) {
    return candidates;
  }
  for (const snapshot of latestTick.snapshots) {
    for (const ticker of snapshot.sample || []) {
      candidates.push(calculateCandidateSignal(snapshot.instType, ticker));
    }
  }
  return candidates
    .filter((candidate) => candidate.instId.length > 0)
    .sort((a, b) => b.score - a.score);
}

function summarizeSignalAction(candidates) {
  const top = candidates[0];
  if (!top) {
    return {
      action: "paper_hold",
      reason: "no_signal_candidates",
      leadInstId: "",
      leadSignal: "paper_neutral_watch",
      leadScore: 0,
    };
  }
  if (top.score >= 70 && top.signal === "paper_long_candidate") {
    return {
      action: "paper_watch_long",
      reason: "top_candidate_score_high",
      leadInstId: top.instId,
      leadSignal: top.signal,
      leadScore: top.score,
    };
  }
  if (top.score <= 30 && top.signal === "paper_short_candidate") {
    return {
      action: "paper_watch_short",
      reason: "top_candidate_score_low",
      leadInstId: top.instId,
      leadSignal: top.signal,
      leadScore: top.score,
    };
  }
  return {
    action: "paper_hold",
    reason: "signal_strength_not_enough",
    leadInstId: top.instId,
    leadSignal: top.signal,
    leadScore: top.score,
  };
}

export async function buildOkxPaperSignalGate(options = {}) {
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const staleThresholdMs = Number.isInteger(options.staleThresholdMs)
    ? options.staleThresholdMs
    : DEFAULT_STALE_THRESHOLD_MS;
  const autoWarmupLoop = options.autoWarmupLoop !== false;

  let loopReport = await readJsonIfExists(LOOP_REPORT_PATH);
  if (!loopReport && autoWarmupLoop) {
    await runOkxMarketSnapshotLoop({
      intervalMs: 1000,
      ticks: 1,
      outputPath: LOOP_REPORT_PATH,
      lockPath: LOOP_WARMUP_LOCK_PATH,
      writeState: true,
      quiet: true,
    });
    loopReport = await readJsonIfExists(LOOP_REPORT_PATH);
  }

  const [apiStatus, orderProposal] = await Promise.all([
    buildOkxApiStatusGate({ now: options.now }),
    buildOkxOrderProposalGate({ now: options.now }),
  ]);

  const blockers = [];
  if (!loopReport) {
    blockers.push("loop_report_missing");
  } else if (loopReport.schema !== "openclaw.okx.market-snapshot-loop.v1") {
    blockers.push("loop_report_schema_blocked");
  }

  const latestTick = loopReport?.latestTick || null;
  if (!latestTick) {
    blockers.push("latest_tick_missing");
  } else {
    if (latestTick.status !== "tick_ok") {
      blockers.push("latest_tick_not_ok");
    }
    const finishedAtMs = Date.parse(latestTick.finishedAt || "");
    if (Number.isFinite(finishedAtMs) && Date.now() - finishedAtMs > staleThresholdMs) {
      blockers.push("loop_stale");
    }
  }

  const candidates = extractSignalCandidates(loopReport);
  if (candidates.length === 0) {
    blockers.push("signal_candidates_missing");
  }
  const policyWarnings = buildPolicyWarnings({ apiStatus, orderProposal });
  const signalSummary = summarizeSignalAction(candidates);
  const status =
    blockers.length === 0
      ? policyWarnings.length === 0
        ? "paper_signal_ready"
        : "paper_signal_ready_with_policy_warnings"
      : "blocked_or_degraded";

  return {
    schema: "openclaw.okx.paper-signal-gate.v1",
    generatedAt,
    provider: "okx",
    language: "zh-TW",
    mode: "paper_only_strategy_signal",
    status,
    summary_zh_tw:
      status === "blocked_or_degraded"
        ? `OKX paper signal gate 阻擋：${blockers.join("、")}。`
        : policyWarnings.length === 0
          ? `OKX paper signal 就緒；主訊號 ${signalSummary.leadInstId || "none"} ${signalSummary.action}。`
          : `OKX paper signal 可用，但有政策警示：${policyWarnings.join("、")}。`,
    blockers: [...new Set(blockers)],
    policyWarnings,
    markers: [
      status,
      signalSummary.action,
      "paper_only_mode",
      "orders_disabled",
      ...policyWarnings,
      ...blockers,
    ],
    dependsOn: {
      loopReport: "reports/hermes-agent/state/openclaw-okx-market-snapshot-loop-latest.json",
      apiStatusReport: "reports/hermes-agent/state/openclaw-okx-api-status-gate-latest.json",
      orderProposalReport:
        "reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json",
      loopSchema: loopReport?.schema || "",
      apiStatusSchema: apiStatus.schema,
      orderProposalSchema: orderProposal.schema,
      loopGeneratedAt: loopReport?.generatedAt || "",
      latestTickFinishedAt: latestTick?.finishedAt || "",
    },
    cadence: {
      expectedIntervalMs: 1000,
      staleThresholdMs,
      latestTickDurationMs: latestTick?.durationMs || 0,
      latestTotalListedCount: latestTick?.totalListedCount || 0,
      latestTotalWithLastPriceCount: latestTick?.totalWithLastPriceCount || 0,
      rateLimit: loopReport?.rateLimit || {},
    },
    signal: {
      action: signalSummary.action,
      reason: signalSummary.reason,
      leadInstId: signalSummary.leadInstId,
      leadSignal: signalSummary.leadSignal,
      leadScore: signalSummary.leadScore,
      topCandidates: candidates.slice(0, 8),
      longCandidateCount: candidates.filter(
        (candidate) => candidate.signal === "paper_long_candidate",
      ).length,
      shortCandidateCount: candidates.filter(
        (candidate) => candidate.signal === "paper_short_candidate",
      ).length,
      neutralCandidateCount: candidates.filter(
        (candidate) => candidate.signal === "paper_neutral_watch",
      ).length,
    },
    safety: {
      paperOnly: true,
      readOnly: true,
      dryRunOnly: true,
      executionAllowed: false,
      orderPlacementEnabled: false,
      cancelOrderEnabled: false,
      amendOrderEnabled: false,
      submittedOrder: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      withdrawalEnabled: false,
      accountCredentialRequired: false,
      credentialEchoed: false,
      storesSecretsInRepo: false,
    },
    commands: {
      executed: [
        "read reports/hermes-agent/state/openclaw-okx-market-snapshot-loop-latest.json",
        "okx api status gate dependency",
        "okx order proposal gate dependency",
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
      "Remove package scripts okx:paper-signal and okx:paper-signal:check.",
      "Delete scripts/openclaw-okx-paper-signal-gate.mjs and scripts/check-openclaw-okx-paper-signal-gate.mjs.",
      "Delete reports/hermes-agent/state/openclaw-okx-paper-signal-gate-latest.json and .sha256.",
      "Remove OKX paper-signal references from skills/openclaw-okx-cex-status/SKILL.md and docs/automation/module-skill-inventory.md.",
    ],
    nextSafeTask:
      status === "blocked_or_degraded"
        ? "修復 loop blocker 後重跑 okx:paper-signal:check；交易仍維持 dry-run。"
        : "把 paper signal top candidate 預填到 okx:order-proposal（dry-run）並保留 submittedOrder=false。",
  };
}

async function main() {
  const report = await buildOkxPaperSignalGate({
    staleThresholdMs: toPositiveInt(
      argValue("--stale-ms", String(DEFAULT_STALE_THRESHOLD_MS)),
      DEFAULT_STALE_THRESHOLD_MS,
    ),
    autoWarmupLoop: !hasFlag("--no-warmup-loop"),
  });
  const outputPath = path.resolve(argValue("--output", DEFAULT_REPORT_PATH));
  if (hasFlag("--write-state")) {
    await writeJsonWithHash(outputPath, report);
  }
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.summary_zh_tw}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `okx paper signal gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
