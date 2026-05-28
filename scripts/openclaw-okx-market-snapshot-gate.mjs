import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-market-snapshot-gate-latest.json",
);
const INST_TYPES = ["SPOT", "SWAP", "FUTURES", "OPTION"];

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

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveOkxCliEntry() {
  const override = process.env.OPENCLAW_OKX_CLI_ENTRY;
  if (override && (await pathExists(override))) {
    return override;
  }
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(
      path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "@okx_ai",
        "okx-trade-cli",
        "dist",
        "index.js",
      ),
    );
  }
  if (process.env.PREFIX) {
    candidates.push(
      path.join(process.env.PREFIX, "node_modules", "@okx_ai", "okx-trade-cli", "dist", "index.js"),
    );
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function sanitizeOutput(value) {
  return String(value || "")
    .replace(/(api[_ -]?key\s+)(\S+)/giu, "$1<redacted>")
    .replace(/(secret[_ -]?key\s+)(\S+)/giu, "$1<redacted>")
    .replace(/(passphrase\s+)(\S+)/giu, "$1<redacted>")
    .trim();
}

function runOkx(cliEntry, args) {
  if (!cliEntry) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: "okx_cli_not_found",
    };
  }
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: sanitizeOutput(result.stdout),
    stderr: sanitizeOutput(result.stderr),
    error: result.error?.message || "",
  };
}

function parseTickers(stdout) {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed?.data)) {
    return parsed.data;
  }
  return [];
}

function summarizeTickers(instType, run) {
  if (!run.ok) {
    return {
      instType,
      code: `${instType.toLowerCase()}_blocked`,
      ok: false,
      commandStatus: run.status,
      listedCount: 0,
      withTimestampCount: 0,
      withLastPriceCount: 0,
      newestTs: "",
      oldestTs: "",
      sample: [],
      error: run.error || run.stderr || "ticker_query_failed",
    };
  }
  try {
    const tickers = parseTickers(run.stdout);
    const timestamps = tickers
      .map((ticker) => Number(ticker?.ts || 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      instType,
      code:
        tickers.length > 0
          ? `${instType.toLowerCase()}_snapshot_ok`
          : `${instType.toLowerCase()}_empty`,
      ok: tickers.length > 0,
      commandStatus: run.status,
      listedCount: tickers.length,
      withTimestampCount: timestamps.length,
      withLastPriceCount: tickers.filter((ticker) => String(ticker?.last || "").length > 0).length,
      newestTs: timestamps.length ? String(Math.max(...timestamps)) : "",
      oldestTs: timestamps.length ? String(Math.min(...timestamps)) : "",
      sample: tickers.slice(0, 5).map((ticker) => ({
        instId: String(ticker?.instId || ""),
        last: String(ticker?.last || ""),
        bidPx: String(ticker?.bidPx || ""),
        askPx: String(ticker?.askPx || ""),
        ts: String(ticker?.ts || ""),
      })),
      error: "",
    };
  } catch (error) {
    return {
      instType,
      code: `${instType.toLowerCase()}_parse_blocked`,
      ok: false,
      commandStatus: run.status,
      listedCount: 0,
      withTimestampCount: 0,
      withLastPriceCount: 0,
      newestTs: "",
      oldestTs: "",
      sample: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

export async function buildOkxMarketSnapshotGate(options = {}) {
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const cliEntry = await resolveOkxCliEntry();
  const instTypes =
    Array.isArray(options.instTypes) && options.instTypes.length ? options.instTypes : INST_TYPES;
  const snapshots = instTypes.map((instType) =>
    summarizeTickers(instType, runOkx(cliEntry, ["market", "tickers", instType, "--json"])),
  );
  const blockers = snapshots.filter((snapshot) => !snapshot.ok).map((snapshot) => snapshot.code);
  const totalListedCount = snapshots.reduce((sum, snapshot) => sum + snapshot.listedCount, 0);
  const totalWithLastPriceCount = snapshots.reduce(
    (sum, snapshot) => sum + snapshot.withLastPriceCount,
    0,
  );

  return {
    schema: "openclaw.okx.market-snapshot-gate.v1",
    generatedAt,
    provider: "okx",
    language: "zh-TW",
    mode: "read_only_market_snapshot",
    status: blockers.length === 0 ? "all_market_snapshots_ok" : "blocked_or_degraded",
    markers: [
      ...snapshots.map((snapshot) => snapshot.code),
      "read_only_market_data",
      "snapshot_not_streaming",
      "no_account_required",
      "orders_disabled",
    ],
    blockers,
    summary_zh_tw:
      blockers.length === 0
        ? `OKX 全商品類型 snapshot 可讀：SPOT/SWAP/FUTURES/OPTION，共 ${totalListedCount} 筆 ticker。`
        : `OKX market snapshot 部分阻擋：${blockers.join("、")}。`,
    cli: {
      available: Boolean(cliEntry),
      entryResolved: Boolean(cliEntry),
    },
    coverage: {
      instTypes,
      totalListedCount,
      totalWithLastPriceCount,
      continuousStreamingEnabled: false,
      snapshotOnly: true,
    },
    snapshots,
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
    commands: {
      executed: instTypes.map((instType) => `okx market tickers ${instType} --json`),
      forbidden: [
        "okx spot place",
        "okx swap place",
        "okx futures place",
        "okx spot cancel",
        "okx swap cancel",
      ],
    },
    nextSafeTask:
      blockers.length === 0
        ? "把 OKX scheduler freshness 納入 current-readiness summary；仍保持 read-only。"
        : "修復被阻擋的 OKX market snapshot 類型，再重跑 okx:market-snapshot:check。",
  };
}

async function main() {
  const instTypesArg = argValue("--inst-types", "");
  const report = await buildOkxMarketSnapshotGate({
    instTypes: instTypesArg
      ? instTypesArg
          .split(",")
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean)
      : INST_TYPES,
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
      `okx market snapshot gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
