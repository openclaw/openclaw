import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const STATE_DIR = path.join(repoRoot, "reports", "hermes-agent", "state");
const DEFAULT_REPORT_PATH = path.join(STATE_DIR, "openclaw-okx-market-snapshot-loop-latest.json");
const DEFAULT_LOCK_PATH = path.join(STATE_DIR, "openclaw-okx-market-snapshot-loop.lock.json");
const OKX_BASE = "https://www.okx.com";
const INST_TYPES = ["SPOT", "SWAP", "FUTURES", "OPTION"];
const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 1000;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLoopLock(lockPath, intervalMs) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const existing = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const expiresAt = Date.parse(existing.expiresAt || "");
    if (isProcessAlive(existing.pid) || (Number.isFinite(expiresAt) && expiresAt > Date.now())) {
      throw new Error(
        `BLOCKED_BY_ACTIVE_TASK okx market snapshot loop lock active pid=${existing.pid}`,
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !String(error?.message || "").startsWith("Unexpected")) {
      throw error;
    }
  }
  const lock = {
    schema: "openclaw.okx.market-snapshot-loop.lock.v1",
    pid: process.pid,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Math.max(intervalMs * 5, 10000)).toISOString(),
  };
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

async function refreshLoopLock(lockPath, intervalMs) {
  const lock = {
    schema: "openclaw.okx.market-snapshot-loop.lock.v1",
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Math.max(intervalMs * 5, 10000)).toISOString(),
  };
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

async function okxFetchTickers(instType) {
  const started = performance.now();
  const url = `${OKX_BASE}/api/v5/market/tickers?instType=${encodeURIComponent(instType)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "OpenClaw/1.0 market-snapshot-loop" },
    signal: AbortSignal.timeout(800),
  });
  const durationMs = Math.round(performance.now() - started);
  if (!response.ok) {
    throw new Error(`OKX_API_${response.status}`);
  }
  const body = await response.json();
  if (body?.code !== "0") {
    throw new Error(`OKX_CODE_${body?.code || "missing"}`);
  }
  return { durationMs, data: Array.isArray(body.data) ? body.data : [] };
}

function summarizeTickers(instType, result) {
  if (result.status !== "fulfilled") {
    return {
      instType,
      code: `${instType.toLowerCase()}_loop_blocked`,
      ok: false,
      listedCount: 0,
      withLastPriceCount: 0,
      newestTs: "",
      durationMs: 0,
      sample: [],
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  }
  const tickers = result.value.data;
  const timestamps = tickers
    .map((ticker) => Number(ticker?.ts || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    instType,
    code:
      tickers.length > 0
        ? `${instType.toLowerCase()}_loop_ok`
        : `${instType.toLowerCase()}_loop_empty`,
    ok: tickers.length > 0,
    listedCount: tickers.length,
    withLastPriceCount: tickers.filter((ticker) => String(ticker?.last || "").length > 0).length,
    newestTs: timestamps.length ? String(Math.max(...timestamps)) : "",
    durationMs: result.value.durationMs,
    sample: tickers.slice(0, 3).map((ticker) => ({
      instId: String(ticker?.instId || ""),
      last: String(ticker?.last || ""),
      bidPx: String(ticker?.bidPx || ""),
      askPx: String(ticker?.askPx || ""),
      open24h: String(ticker?.open24h || ""),
      high24h: String(ticker?.high24h || ""),
      low24h: String(ticker?.low24h || ""),
      volCcy24h: String(ticker?.volCcy24h || ""),
      vol24h: String(ticker?.vol24h || ""),
      ts: String(ticker?.ts || ""),
    })),
    error: "",
  };
}

async function buildLoopTick(sequence) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results = await Promise.allSettled(INST_TYPES.map((instType) => okxFetchTickers(instType)));
  const snapshots = INST_TYPES.map((instType, index) => summarizeTickers(instType, results[index]));
  const blockers = snapshots.filter((snapshot) => !snapshot.ok).map((snapshot) => snapshot.code);
  const durationMs = Math.round(performance.now() - started);
  return {
    sequence,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    status: blockers.length === 0 ? "tick_ok" : "tick_blocked",
    blockers,
    totalListedCount: snapshots.reduce((sum, snapshot) => sum + snapshot.listedCount, 0),
    totalWithLastPriceCount: snapshots.reduce(
      (sum, snapshot) => sum + snapshot.withLastPriceCount,
      0,
    ),
    snapshots,
  };
}

function buildLoopReport({ intervalMs, requestedTicks, ticks }) {
  const blockers = [...new Set(ticks.flatMap((tick) => tick.blockers))];
  const durations = ticks.map((tick) => tick.durationMs);
  const latestTick = ticks.at(-1) || null;
  return {
    schema: "openclaw.okx.market-snapshot-loop.v1",
    generatedAt: new Date().toISOString(),
    provider: "okx",
    language: "zh-TW",
    mode: "read_only_1s_market_loop",
    status: blockers.length === 0 ? "one_second_loop_ok" : "blocked_or_degraded",
    intervalMs,
    requestedTicks,
    completedTicks: ticks.length,
    markers: [
      "one_second_market_loop",
      "spot_loop_ok",
      "swap_loop_ok",
      "futures_loop_ok",
      "option_loop_ok",
      "read_only_market_data",
      "orders_disabled",
      "paper_or_dry_run_only",
    ],
    blockers,
    summary_zh_tw:
      blockers.length === 0
        ? `OKX 每秒報價 loop 可跑；最近一輪 ${latestTick?.totalListedCount || 0} 筆 ticker。`
        : `OKX 每秒報價 loop 部分阻擋：${blockers.join("、")}。`,
    rateLimit: {
      officialGetMarketTickersLimit: "20 requests per 2 seconds",
      officialRateLimitRule: "IP",
      requestsPerTick: INST_TYPES.length,
      requestsPerSecondAtConfiguredInterval: Math.round((INST_TYPES.length * 1000) / intervalMs),
      belowOfficialTickerLimit: intervalMs >= 1000 && INST_TYPES.length <= 10,
      source: "https://www.okx.com/docs-v5/en/",
    },
    timing: {
      minTickDurationMs: durations.length ? Math.min(...durations) : 0,
      maxTickDurationMs: durations.length ? Math.max(...durations) : 0,
      averageTickDurationMs: durations.length
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : 0,
    },
    latestTick,
    recentTicks: ticks.slice(-10),
    safety: {
      readOnly: true,
      accountCredentialRequired: false,
      orderPlacementEnabled: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      withdrawalEnabled: false,
      submittedOrder: false,
      credentialEchoed: false,
      storesSecretsInRepo: false,
    },
    nextSafeTask:
      blockers.length === 0
        ? "執行 okx:paper-signal:check，將每秒報價 loop 接到 paper-only strategy signal gate；仍不送真單。"
        : "修復 OKX 每秒報價 loop blocker 後重跑 okx:market-loop:check。",
  };
}

export async function runOkxMarketSnapshotLoop(options = {}) {
  const requestedIntervalMs = Number.isInteger(options.intervalMs)
    ? options.intervalMs
    : DEFAULT_INTERVAL_MS;
  const intervalMs = Math.max(requestedIntervalMs, MIN_INTERVAL_MS);
  const requestedTicks = Number.isInteger(options.ticks) ? options.ticks : 0;
  const outputPath = options.outputPath || DEFAULT_REPORT_PATH;
  const lockPath = options.lockPath || DEFAULT_LOCK_PATH;
  const writeState = options.writeState === true;
  const quiet = options.quiet === true;
  const ticks = [];

  await acquireLoopLock(lockPath, intervalMs);
  try {
    let sequence = 0;
    while (requestedTicks === 0 || sequence < requestedTicks) {
      const tickStart = performance.now();
      sequence += 1;
      await refreshLoopLock(lockPath, intervalMs);
      const tick = await buildLoopTick(sequence);
      ticks.push(tick);
      const report = buildLoopReport({ intervalMs, requestedTicks, ticks });
      if (writeState) {
        await writeJsonWithHash(outputPath, report);
      }
      if (!quiet) {
        process.stdout.write(
          `OKX_MARKET_LOOP_TICK=${sequence} status=${tick.status} count=${tick.totalListedCount} durationMs=${tick.durationMs}\n`,
        );
      }
      if (requestedTicks !== 0 && sequence >= requestedTicks) {
        return report;
      }
      const elapsed = Math.round(performance.now() - tickStart);
      await sleep(Math.max(0, intervalMs - elapsed));
    }
    return buildLoopReport({ intervalMs, requestedTicks, ticks });
  } finally {
    await removeFileIfExists(lockPath);
  }
}

async function main() {
  const report = await runOkxMarketSnapshotLoop({
    intervalMs: toPositiveInt(
      argValue("--interval-ms", String(DEFAULT_INTERVAL_MS)),
      DEFAULT_INTERVAL_MS,
    ),
    ticks: Number.parseInt(argValue("--ticks", "0"), 10) || 0,
    outputPath: path.resolve(argValue("--output", DEFAULT_REPORT_PATH)),
    writeState: hasFlag("--write-state"),
    quiet: hasFlag("--json") || hasFlag("--quiet"),
  });
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `okx market snapshot loop failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
