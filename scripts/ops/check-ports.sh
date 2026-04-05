#!/usr/bin/env bash
set -euo pipefail

# ─── OpenClaw Port Conflict Checker ──────────────────────────────────────────
#
# Usage:
#   ./check-ports.sh [agents_dir]
#
# Scans all agent docker.env files for port assignments and reports duplicates.
# Can run locally on a Hetzner server or remotely via SSH.
#
# Default agents_dir: /root/.openclaw/agents

AGENTS_DIR="${1:-/root/.openclaw/agents}"

if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "ERROR: Agents directory not found: $AGENTS_DIR" >&2
  exit 1
fi

declare -A SEEN=()
CONFLICTS=0
AGENTS=0

for env_file in "$AGENTS_DIR"/*/docker.env; do
  [[ -f "$env_file" ]] || continue
  agent=$(basename "$(dirname "$env_file")")
  AGENTS=$((AGENTS + 1))

  for key in OPENCLAW_GATEWAY_PORT OPENCLAW_BRIDGE_PORT; do
    port=$(grep -E "^${key}=" "$env_file" 2>/dev/null | cut -d= -f2 || true)
    [[ -z "$port" ]] && continue
    label="${key}:${port}"
    if [[ -n "${SEEN[$label]:-}" ]]; then
      echo "CONFLICT: Port $port ($key) used by both '${SEEN[$label]}' and '$agent'" >&2
      CONFLICTS=$((CONFLICTS + 1))
    else
      SEEN[$label]="$agent"
    fi
  done
done

echo ""
echo "Scanned $AGENTS agents."
if [[ $CONFLICTS -gt 0 ]]; then
  echo "Found $CONFLICTS port conflict(s). Fix before deploying." >&2
  exit 1
else
  echo "No port conflicts."
  exit 0
fi
