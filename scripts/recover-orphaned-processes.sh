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
  cat <<'EOF'
Usage: recover-orphaned-processes.sh

Scans for likely orphaned coding agent processes and prints JSON.
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -gt 0 ]; then
  usage >&2
  exit 2
fi

node <<'NODE'
const { execSync } = require("node:child_process");
const fs = require("node:fs");

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function resolveStarted(pid) {
  const started = run(`ps -o lstart= -p ${pid}`).trim();
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
  const lsof = run(`lsof -a -d cwd -p ${pid} -Fn`);
  const match = lsof.match(/^n(.+)$/m);
  return match ? match[1] : "unknown";
}

// Pre-filter candidate PIDs using pgrep to avoid scanning all processes.
// Falls back to full ps scan if pgrep is unavailable.
const candidatePids = run("pgrep -f 'codex|claude' 2>/dev/null || true")
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && /^\d+$/.test(s));

let lines;
if (candidatePids.length > 0) {
  // Fetch command info only for candidate PIDs.
  lines = run(`ps -o pid=,command= -p ${candidatePids.join(",")}`).split("\n");
} else {
  lines = [];
}

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
  if (excludePatterns.some((pattern) => pattern.test(cmd))) {
    continue;
  }

  orphaned.push({
    pid,
    cmd,
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
