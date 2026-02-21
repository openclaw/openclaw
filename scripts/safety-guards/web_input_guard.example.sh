#!/usr/bin/env bash
set -euo pipefail
# External text guard (template)
SOURCE="trusted"
if [ "${1:-}" = "--source" ]; then
  SOURCE="${2:-trusted}"; shift 2
fi
FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "Usage: $0 [--source web|trusted|external] <file>" >&2; exit 2; }

TEXT="$(cat "$FILE")"

if [[ "$SOURCE" == "web" || "$SOURCE" == "external" ]]; then
  if printf '%s' "$TEXT" | grep -Eiq "(^|[[:space:]])(rm|mkfs|dd|chmod|chown|kill|curl|wget|launchctl|sudo)\\s|;|&&|\\|\\||\\$\\(|`|<script|<iframe|eval\\s*\\("; then
    echo "BLOCK_WEB_INPUT"; exit 2
  fi
fi

if printf '%s' "$TEXT" | grep -Eiq "(gho_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9_]{20,}|ghu_[A-Za-z0-9_]{20,}|xox[baprs]-|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|token\s*=)"; then
  echo "BLOCK_WEB_INPUT: secrets-like token pattern detected"; exit 2
fi

echo "SAFE_INPUT"
