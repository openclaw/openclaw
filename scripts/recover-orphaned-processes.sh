#!/usr/bin/env bash
# Scan for orphaned coding agent processes after a gateway restart.
#
# Background coding agents (Claude Code, Codex CLI) spawned by the gateway
# can outlive the session that started them when the gateway restarts.
# This script finds them and reports their state.
#
# Usage:
#   recover-orphaned-processes.sh
#
# Output: JSON object with `orphaned` array and `ts` timestamp.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: recover-orphaned-processes.sh

Scans for likely orphaned coding agent processes and prints JSON.
USAGE
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -gt 0 ]; then
  usage >&2
  exit 2
fi

if ! command -v node &>/dev/null; then
  _ts="unknown"
  command -v date &>/dev/null && _ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || true
  [ -z "$_ts" ] && _ts="unknown"
  printf '{"error":"node not found on PATH","orphaned":[],"ts":"%s"}\n' "$_ts"
  exit 0
fi

node <<'NODE'
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

let username = process.env.USER || process.env.LOGNAME || "";

if (username && !/^[a-zA-Z0-9._-]+$/.test(username)) {
  username = "";
}

function runFile(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    if (err && typeof err.stdout === "string") {
      return err.stdout;
    }
    if (err && err.stdout && Buffer.isBuffer(err.stdout)) {
      return err.stdout.toString("utf8");
    }
    return "";
  }
}

function resolveStarted(pid) {
  const started = runFile("ps", ["-o", "lstart=", "-p", String(pid)]).trim();
  return started.length > 0 ? started : "unknown";
}

function resolveCwd(pid) {
  if (process.platform === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return "unknown";
    }
  }
  const lsof = runFile("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"]);
  const match = lsof.match(/^n(.+)$/m);
  return match ? match[1] : "unknown";
}

function sanitizeCommand(cmd) {
  // Avoid leaking obvious secrets when this diagnostic output is shared.
  return cmd
    .replace(
      /(--(?:token|api[-_]?key|password|secret|authorization)\s+)([^\s]+)/gi,
      "$1<redacted>",
    )
    .replace(
      /((?:token|api[-_]?key|password|secret|authorization)=)([^\s]+)/gi,
      "$1<redacted>",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1<redacted>");
}

// Pre-filter candidate PIDs using pgrep to avoid scanning all processes.
// Only falls back to a full ps scan when pgrep is genuinely unavailable
// (ENOENT), not when it simply finds no matches (exit code 1).
let pgrepUnavailable = false;
const pgrepResult = (() => {
  const args =
    username.length > 0
      ? ["-u", username, "-f", "codex|claude"]
      : ["-f", "codex|claude"];
  try {
    return execFileSync("pgrep", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      pgrepUnavailable = true;
      return "";
    }
    // pgrep exit code 1 = no matches — return stdout (empty)
    if (err && typeof err.stdout === "string") return err.stdout;
    return "";
  }
})();

const candidatePids = pgrepResult
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && /^\d+$/.test(s));

let lines;
if (candidatePids.length > 0) {
  // Fetch command info only for candidate PIDs.
  lines = runFile("ps", ["-o", "pid=,command=", "-p", candidatePids.join(",")]).split("\n");
} else if (pgrepUnavailable && username.length > 0) {
  // pgrep not installed — fall back to user-scoped ps scan.
  lines = runFile("ps", ["-U", username, "-o", "pid=,command="]).split("\n");
} else if (pgrepUnavailable) {
  // pgrep not installed and no username — full scan as last resort.
  lines = runFile("ps", ["-axo", "pid=,command="]).split("\n");
} else {
  // pgrep ran successfully but found no matches — no orphans.
  lines = [];
}

const includePattern = /codex|claude/i;

const excludePatterns = [
  /openclaw-gateway/i,
  /signal-cli/i,
  /node_modules\/\.bin\/openclaw/i,
  /recover-orphaned-processes\.sh/i,
];

const orphaned = [];

for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line) {
    continue;
  }
  const match = line.match(/^(\d+)\s+(.+)$/);
  if (!match) {
    continue;
  }

  const pid = Number(match[1]);
  const cmd = match[2];
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    continue;
  }
  if (!includePattern.test(cmd)) {
    continue;
  }
  if (excludePatterns.some((pattern) => pattern.test(cmd))) {
    continue;
  }

  orphaned.push({
    pid,
    cmd: sanitizeCommand(cmd),
    cwd: resolveCwd(pid),
    started: resolveStarted(pid),
  });
}

process.stdout.write(
  JSON.stringify({
    orphaned,
    ts: new Date().toISOString(),
  }) + "\n",
);
NODE
