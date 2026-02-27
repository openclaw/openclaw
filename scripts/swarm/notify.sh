#!/usr/bin/env bash
set -euo pipefail
MSG="${1:?message required}"

if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${MSG}" >/dev/null
  exit 0
fi

if command -v openclaw >/dev/null 2>&1 && [[ -n "${OPENCLAW_TELEGRAM_TARGET:-}" ]]; then
  openclaw message send --channel telegram --target "${OPENCLAW_TELEGRAM_TARGET}" --message "${MSG}" >/dev/null
  exit 0
fi

echo "[notify] $MSG"
