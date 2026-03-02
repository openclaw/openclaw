#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT_DIR/memory/qdrant-index-state.json"
INDEX_SCRIPT="$ROOT_DIR/scripts/qdrant-memory-index.mjs"
NOW_TS="$(date +%s)"
INTERVAL_SEC="${OPENCLAW_QDRANT_INDEX_INTERVAL_SEC:-21600}"

if [[ "${OPENCLAW_QDRANT_MEMORY_ENABLED:-false}" != "true" ]]; then
  echo "Qdrant memory sidecar disabled (OPENCLAW_QDRANT_MEMORY_ENABLED!=true). Skipping."
  exit 0
fi

get_last_index_ts() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "null"
    return
  fi
  local value
  value="$(sed -n 's/.*"last_index_ts":[[:space:]]*\([0-9][0-9]*\|null\).*/\1/p' "$STATE_FILE" | head -n1 || true)"
  if [[ -z "$value" ]]; then
    echo "null"
  else
    echo "$value"
  fi
}

last_index_ts="$(get_last_index_ts)"
if [[ "$last_index_ts" == "null" ]]; then
  echo "No Qdrant index state found. Running index now..."
  node "$INDEX_SCRIPT"
  exit 0
fi

age_sec=$((NOW_TS - last_index_ts))
if (( age_sec >= INTERVAL_SEC )); then
  echo "Qdrant index due (${age_sec}s since last index). Running now..."
  node "$INDEX_SCRIPT"
  exit 0
fi

echo "Qdrant index not due yet (${age_sec}s age < ${INTERVAL_SEC}s interval)."
