#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${OPENCLAW_LOG_DIR:-/tmp/openclaw}"
TAIL_LINES="${TAIL_LINES:-80}"
LOG_LINK="$LOG_DIR/wechat-linux-gateway.latest.log"

"$ROOT_DIR/scripts/run-wechat-linux-local.sh" --background "$@"

for _ in {1..50}; do
  if [[ -L "$LOG_LINK" || -f "$LOG_LINK" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -L "$LOG_LINK" && ! -f "$LOG_LINK" ]]; then
  printf 'ERROR: latest log link not found: %s\n' "$LOG_LINK" >&2
  exit 1
fi

resolved_log="$(readlink -f "$LOG_LINK" 2>/dev/null || printf '%s' "$LOG_LINK")"
printf '[wechat-linux-start-tail] tailing %s\n' "$resolved_log"
tail -n "$TAIL_LINES" -f "$resolved_log"
