#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Collect a deterministic OpenClaw runtime snapshot.

Usage:
  bash scripts/hunt/collect-runtime.sh [options]

Options:
  --output <path>            Output JSON path (default: stdout)
  --label <name>             Snapshot label (default: snapshot)
  --window-minutes <number>  Log lookback window in minutes (default: 120)
  --port <number>            Gateway port for listener probe (default: 18789)
  --gateway-err-log <path>   gateway.err.log path
  --openclaw-log <path>      openclaw.log path
  -h, --help                 Show help
USAGE
}

OUTPUT_PATH=""
LABEL="snapshot"
WINDOW_MINUTES="120"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_ERR_LOG="${OPENCLAW_GATEWAY_ERR_LOG:-$HOME/.openclaw/logs/gateway.err.log}"
OPENCLAW_LOG_PATH="${OPENCLAW_LOG_PATH:-$HOME/.openclaw/logs/openclaw.log}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    --label)
      LABEL="${2:-}"
      shift 2
      ;;
    --window-minutes)
      WINDOW_MINUTES="${2:-}"
      shift 2
      ;;
    --port)
      GATEWAY_PORT="${2:-}"
      shift 2
      ;;
    --gateway-err-log)
      GATEWAY_ERR_LOG="${2:-}"
      shift 2
      ;;
    --openclaw-log)
      OPENCLAW_LOG_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

export HUNT_LABEL="$LABEL"
export HUNT_WINDOW_MINUTES="$WINDOW_MINUTES"
export HUNT_GATEWAY_PORT="$GATEWAY_PORT"
export HUNT_GATEWAY_ERR_LOG="$GATEWAY_ERR_LOG"
export HUNT_OPENCLAW_LOG="$OPENCLAW_LOG_PATH"

if [[ -n "$OUTPUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUTPUT_PATH")"
fi

collect_json() {
  node - <<'NODE'
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const label = process.env.HUNT_LABEL || "snapshot";
const windowMinutes = Number.parseInt(process.env.HUNT_WINDOW_MINUTES || "120", 10);
const gatewayPort = Number.parseInt(process.env.HUNT_GATEWAY_PORT || "18789", 10);
const gatewayErrLog = process.env.HUNT_GATEWAY_ERR_LOG || `${process.env.HOME || ""}/.openclaw/logs/gateway.err.log`;
const openclawLog = process.env.HUNT_OPENCLAW_LOG || `${process.env.HOME || ""}/.openclaw/logs/openclaw.log`;

function run(command) {
  const result = spawnSync("bash", ["-lc", command], {
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    command,
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function parseIsoAtStart(line) {
  const m = line.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/,
  );
  if (!m) return null;
  const ts = Date.parse(m[1]);
  return Number.isFinite(ts) ? ts : null;
}

function parseIsoFromJsonTimeField(line) {
  const m = line.match(/"time":"([^"]+)"/);
  if (!m) return null;
  const ts = Date.parse(m[1]);
  return Number.isFinite(ts) ? ts : null;
}

function readLogCounts(filePath, pattern, fromTs, toTs) {
  if (!fs.existsSync(filePath)) {
    return { countWindow: 0, countTotal: 0, missing: true };
  }
  const text = fs.readFileSync(filePath, "utf-8");
  const lines = text.split(/\r?\n/);
  let countWindow = 0;
  let countTotal = 0;

  for (const line of lines) {
    if (!line.includes(pattern)) continue;
    countTotal += 1;

    const ts = parseIsoAtStart(line) ?? parseIsoFromJsonTimeField(line);
    if (ts !== null) {
      if (ts >= fromTs && ts <= toTs) {
        countWindow += 1;
      }
    }
  }

  return { countWindow, countTotal, missing: false };
}

const now = new Date();
const toTs = now.getTime();
const fromTs = toTs - windowMinutes * 60 * 1000;

const signatures = [
  {
    name: "slack_listeners_crash",
    source: "gateway.err.log",
    filePath: gatewayErrLog,
    pattern: "Cannot read properties of undefined (reading 'listeners')",
  },
  {
    name: "memory_module_not_available",
    source: "gateway.err.log",
    filePath: gatewayErrLog,
    pattern: "Memory module not available",
  },
  {
    name: "memory_module_unavailable",
    source: "gateway.err.log",
    filePath: gatewayErrLog,
    pattern: "Memory module unavailable",
  },
  {
    name: "extraction_llm_unavailable",
    source: "gateway.err.log",
    filePath: gatewayErrLog,
    pattern: "Extraction skipped (LLM unavailable)",
  },
  {
    name: "recovery_budget_exceeded",
    source: "gateway.err.log",
    filePath: gatewayErrLog,
    pattern: "Recovery time budget exceeded",
  },
  {
    name: "gateway_already_running",
    source: "gateway.err.log",
    filePath: gatewayErrLog,
    pattern: "Gateway failed to start: gateway already running",
  },
  {
    name: "err_pnpm_no_global_bin_dir",
    source: "gateway.err.log",
    filePath: gatewayErrLog,
    pattern: "ERR_PNPM_NO_GLOBAL_BIN_DIR",
  },
  {
    name: "suppressed_abort_error",
    source: "gateway.err.log",
    filePath: gatewayErrLog,
    pattern: "Suppressed AbortError",
  },
  {
    name: "config_invalid",
    source: "openclaw.log",
    filePath: openclawLog,
    pattern: "Config invalid",
  },
  {
    name: "config_schema_additional_properties",
    source: "openclaw.log",
    filePath: openclawLog,
    pattern: "must NOT have additional properties",
  },
  {
    name: "database_not_open",
    source: "openclaw.log",
    filePath: openclawLog,
    pattern: "database is not open",
  },
  {
    name: "token_missing",
    source: "openclaw.log",
    filePath: openclawLog,
    pattern: "token_missing",
  },
  {
    name: "orphaned_user_message_removed",
    source: "openclaw.log",
    filePath: openclawLog,
    pattern: "Removed orphaned user message",
  },
].map((entry) => {
  const counts = readLogCounts(entry.filePath, entry.pattern, fromTs, toTs);
  return {
    name: entry.name,
    source: entry.source,
    filePath: entry.filePath,
    pattern: entry.pattern,
    countWindow: counts.countWindow,
    countTotal: counts.countTotal,
    windowMinutes,
    missingLogFile: counts.missing,
  };
});

const version = run("openclaw --version");
const status = run("openclaw gateway status");
const listeners = run(`lsof -nP -iTCP:${gatewayPort} -sTCP:LISTEN || true`);

const listenerPids = listeners.stdout
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const parts = line.split(/\s+/);
    return Number.parseInt(parts[1] || "", 10);
  })
  .filter((pid) => Number.isFinite(pid));

const report = {
  snapshotVersion: "1",
  label,
  collectedAt: now.toISOString(),
  windowMinutes,
  windowStart: new Date(fromTs).toISOString(),
  windowEnd: now.toISOString(),
  openclawVersion: version.stdout || "unknown",
  commands: {
    version,
    gatewayStatus: status,
    listeners,
  },
  runtime: {
    gatewayPort,
    listenerPids,
    gatewayErrLog,
    openclawLog,
  },
  signatures,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
NODE
}

if [[ -n "$OUTPUT_PATH" ]]; then
  collect_json > "$OUTPUT_PATH"
  echo "Wrote runtime snapshot: $OUTPUT_PATH"
else
  collect_json
fi
