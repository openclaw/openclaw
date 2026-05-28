import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { buildCapitalSessionMappingProbe } from "./openclaw-capital-session-mapping-probe.mjs";

const DEFAULT_WAIT_MS = 7000;
const DEFAULT_MAX_AGE_MS = 45000;
const DEFAULT_TIMEOUT_MS = 90000;

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-session-subscribe-probe.json");
}

function resolveOutputPath(repoRoot, outputPath) {
  if (!outputPath) {
    return defaultOutputPath(repoRoot);
  }
  return path.isAbsolute(outputPath)
    ? path.resolve(outputPath)
    : path.resolve(repoRoot, outputPath);
}

function normalizeSymbol(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function unique(values) {
  return [...new Set(values.map(normalizeSymbol).filter(Boolean))];
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function readPositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseList(raw) {
  return String(raw ?? "")
    .split(/[,\s]+/u)
    .map((item) => normalizeSymbol(item))
    .filter(Boolean);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonPayload(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const direct = safeJsonParse(trimmed);
  if (direct) {
    return direct;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return safeJsonParse(trimmed.slice(start, end + 1));
  }
  return null;
}

function defaultRunnerPath(capitalHftRoot) {
  return path.join(capitalHftRoot, "probe-capital-domestic-session-route.mjs");
}

async function spawnJsonProbe(options) {
  const { runnerPath, capitalHftRoot, candidates, waitMs, maxAgeMs, timeoutMs, env } = options;
  return new Promise((resolve) => {
    const args = [
      runnerPath,
      "--json",
      "--candidates",
      candidates.join(","),
      "--wait-ms",
      String(waitMs),
      "--max-age-ms",
      String(maxAgeMs),
    ];
    const child = spawn(process.execPath, args, {
      cwd: capitalHftRoot,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error),
        payload: null,
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        stdout,
        stderr,
        error: "",
        payload: extractJsonPayload(stdout),
      });
    });
  });
}

function summarizePayload(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const freshRoutes = results
    .filter((item) => item?.fresh === true)
    .map((item) => normalizeSymbol(item.routed || item.requested))
    .filter(Boolean);
  const blockedSymbols = results
    .filter((item) => item?.fresh !== true)
    .map((item) => normalizeSymbol(item.requested || item.routed))
    .filter(Boolean);
  return {
    serviceStatus: payload?.status ?? "",
    serviceBlockerCode: payload?.blockerCode ?? null,
    freshRoutes: unique(freshRoutes),
    blockedSymbols: unique(blockedSymbols),
  };
}

function buildBlockedReport(base, blockerCode, blockerMessage, extra = {}) {
  return {
    ...base,
    status: "blocked",
    blockerCode,
    blockerMessage,
    summary: {
      candidates: base.candidates,
      freshRoutes: [],
      blockedSymbols: base.candidates,
      shouldModifyLiveSubscription: false,
      promotionRequiresManualReview: false,
    },
    serviceProbe: null,
    nextSafeTask:
      "修正 blocker 後重跑 quote-only session subscribe probe；不可直接升 live 訂閱或啟用真單。",
    ...extra,
  };
}

export async function buildCapitalSessionSubscribeProbe(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const capitalHftRoot = path.resolve(
    options.capitalHftRoot || options.stateDir || resolveCapitalHftStateDir(),
  );
  const runnerPath = path.resolve(options.runnerPath || defaultRunnerPath(capitalHftRoot));
  const mappingProbe =
    options.mappingProbe ??
    (await buildCapitalSessionMappingProbe({
      repoRoot,
      stateDir: capitalHftRoot,
    }));
  const candidates = unique(
    options.candidates?.length
      ? options.candidates
      : (mappingProbe.summary?.probeOnlySymbols ?? []),
  );
  const waitMs = readPositiveInt(options.waitMs, DEFAULT_WAIT_MS, 1000, 60000);
  const maxAgeMs = readPositiveInt(options.maxAgeMs, DEFAULT_MAX_AGE_MS, 1000, 300000);
  const timeoutMs = readPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 5000, 300000);
  const output = resolveOutputPath(repoRoot, options.output);
  const base = {
    schema: "openclaw.capital.session-subscribe-probe.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    sentSubscribeCommand: false,
    shouldModifyLiveSubscription: false,
    capitalHftRoot,
    runnerPath,
    waitMs,
    maxAgeMs,
    timeoutMs,
    candidates,
    files: {
      mappingProbe: mappingProbe.files?.output ?? "",
      serviceProbeJson: path.join(
        capitalHftRoot,
        "state",
        "capital_domestic_session_route_probe_latest.json",
      ),
      serviceProbeMarkdown: path.join(
        capitalHftRoot,
        "state",
        "capital_domestic_session_route_probe_latest.md",
      ),
      output,
    },
  };

  if (candidates.length === 0) {
    return buildBlockedReport(
      base,
      "no_probe_only_symbols",
      "session mapping probe 沒有可短時測試的 probeOnlySymbols。",
    );
  }

  if (!existsSync(runnerPath)) {
    return buildBlockedReport(
      base,
      "capital_hft_session_route_probe_missing",
      `找不到 CapitalHftService quote probe runner: ${runnerPath}`,
    );
  }

  const run = await spawnJsonProbe({
    runnerPath,
    capitalHftRoot,
    candidates,
    waitMs,
    maxAgeMs,
    timeoutMs,
    env: options.env ?? {},
  });
  const sentSubscribeCommand = true;

  if (run.timedOut) {
    return buildBlockedReport(
      base,
      "capital_hft_session_route_probe_timeout",
      "quote probe 執行逾時。",
      {
        sentSubscribeCommand,
        process: {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          stderr: run.stderr.slice(-4000),
        },
      },
    );
  }

  if (!run.payload) {
    return buildBlockedReport(
      base,
      "capital_hft_session_route_probe_invalid_json",
      "quote probe 沒有輸出可解析 JSON。",
      {
        sentSubscribeCommand,
        process: {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          error: run.error,
          stdout: run.stdout.slice(-4000),
          stderr: run.stderr.slice(-4000),
        },
      },
    );
  }

  const summary = summarizePayload(run.payload);
  const ready = summary.freshRoutes.length > 0;
  const exitCodeAllowed = run.exitCode === 0 || run.exitCode === 2;
  return {
    ...base,
    sentSubscribeCommand,
    status: ready ? "manual_promotion_review_required" : "blocked",
    blockerCode: ready
      ? null
      : summary.serviceBlockerCode || "no_fresh_session_subscribe_probe_callback",
    blockerMessage: ready
      ? ""
      : "候選 session alias 已送 quote-only subscribe probe，但尚未取得 fresh callback。",
    summary: {
      candidates,
      freshRoutes: summary.freshRoutes,
      blockedSymbols: summary.blockedSymbols.length ? summary.blockedSymbols : candidates,
      shouldModifyLiveSubscription: false,
      promotionRequiresManualReview: ready,
      serviceStatus: summary.serviceStatus,
      exitCodeAllowed,
    },
    serviceProbe: {
      schema: run.payload.schema ?? "",
      status: run.payload.status ?? "",
      blockerCode: run.payload.blockerCode ?? null,
      readOnlyQuoteProbe: run.payload.readOnlyQuoteProbe === true,
      liveTradingEnabled: run.payload.liveTradingEnabled === true,
      sentOrder: run.payload.sentOrder === true,
      results: Array.isArray(run.payload.results) ? run.payload.results : [],
    },
    process: {
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stderr: run.stderr.slice(-4000),
    },
    nextSafeTask: ready
      ? `人工審核 freshRoutes=${summary.freshRoutes.join(",")} 後，才建立 promotion patch；真單仍封鎖。`
      : "查官方商品代號、交易時段、SKQuoteLib marketNo/海外訂閱路由，並於開盤或有權限時重跑 quote-only probe。",
  };
}

export async function writeCapitalSessionSubscribeProbe(report, outputPath) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, text, "utf8");
  await fs.writeFile(`${outputPath}.sha256`, `${sha256Text(text)}\n`, "ascii");
  return outputPath;
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    capitalHftRoot: "",
    runnerPath: "",
    output: "",
    writeState: false,
    json: false,
    waitMs: DEFAULT_WAIT_MS,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    candidates: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--state-dir" || arg === "--capital-hft-root") {
      options.capitalHftRoot = argv[++index] ?? options.capitalHftRoot;
    } else if (arg.startsWith("--state-dir=")) {
      options.capitalHftRoot = arg.slice("--state-dir=".length);
    } else if (arg.startsWith("--capital-hft-root=")) {
      options.capitalHftRoot = arg.slice("--capital-hft-root=".length);
    } else if (arg === "--runner-path") {
      options.runnerPath = argv[++index] ?? options.runnerPath;
    } else if (arg.startsWith("--runner-path=")) {
      options.runnerPath = arg.slice("--runner-path=".length);
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--wait-ms") {
      options.waitMs = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--wait-ms=")) {
      options.waitMs = Number(arg.slice("--wait-ms=".length));
    } else if (arg === "--max-age-ms") {
      options.maxAgeMs = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--max-age-ms=")) {
      options.maxAgeMs = Number(arg.slice("--max-age-ms=".length));
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg === "--candidates") {
      options.candidates = parseList(argv[++index] ?? "");
    } else if (arg.startsWith("--candidates=")) {
      options.candidates = parseList(arg.slice("--candidates=".length));
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const report = await buildCapitalSessionSubscribeProbe(options);
  const outputPath = options.writeState
    ? await writeCapitalSessionSubscribeProbe(report, resolveOutputPath(repoRoot, options.output))
    : "";
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, outputPath }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "OpenClaw Capital session subscribe probe",
      `status=${report.status}`,
      `blockerCode=${report.blockerCode ?? "none"}`,
      `candidates=${report.summary.candidates.join(",") || "none"}`,
      `freshRoutes=${report.summary.freshRoutes.join(",") || "none"}`,
      `sentSubscribeCommand=${report.sentSubscribeCommand}`,
      `sentOrder=${report.sentOrder}`,
      outputPath ? `stateFile=${outputPath}` : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital session subscribe probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
