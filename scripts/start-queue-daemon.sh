#!/bin/bash
# Start the Persistent Queue Worker (Prefork Manager)
# Replaces the old shell-based run_queue.sh loop.
#
# Usage:
#   ./scripts/start-queue-daemon.sh
#
# Environment:
#   OPENCLAW_QUEUE_POLL_MS  – poll interval in ms (default: 200)
#   OPENCLAW_QUEUE_DIR      – queue directory override

set -euo pipefail
cd "$(dirname "$0")/.."

echo "[queue-daemon] Starting prefork queue manager (PID $$)..."

# Prefer bun > tsx > ts-node for running TypeScript directly
if command -v bun &>/dev/null; then
  exec bun skills/anti-timeout-orchestrator/src/manager.ts "$@"
elif command -v tsx &>/dev/null; then
  exec tsx skills/anti-timeout-orchestrator/src/manager.ts "$@"
elif command -v npx &>/dev/null; then
  exec npx tsx skills/anti-timeout-orchestrator/src/manager.ts "$@"
else
  echo "[queue-daemon] Error: no TypeScript runner found (bun/tsx/npx). Aborting." >&2
  exit 1
fi
