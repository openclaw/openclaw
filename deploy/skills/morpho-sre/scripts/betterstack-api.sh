#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  betterstack-api.sh <METHOD> <PATH> [JSON_FILE]

Examples:
  betterstack-api.sh GET /incidents
  betterstack-api.sh GET '/incidents?per_page=1'

Env:
  BETTERSTACK_API_TOKEN (required)
  BETTERSTACK_API_BASE (optional; default: https://uptime.betterstack.com/api/v2)
  BETTERSTACK_ALLOWED_HOST (optional; default: uptime.betterstack.com)
EOF
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

METHOD="$1"
PATH_PART="$2"
JSON_FILE="${3:-}"

BETTERSTACK_API_BASE="${BETTERSTACK_API_BASE:-https://uptime.betterstack.com/api/v2}"
BETTERSTACK_ALLOWED_HOST="${BETTERSTACK_ALLOWED_HOST:-uptime.betterstack.com}"

if [[ -z "${BETTERSTACK_API_TOKEN:-}" ]]; then
  echo "Missing required env: BETTERSTACK_API_TOKEN" >&2
  exit 1
fi

if [[ "$PATH_PART" != /* ]]; then
  echo "PATH must start with / (got: $PATH_PART)" >&2
  exit 1
fi

base_host="$(printf '%s' "$BETTERSTACK_API_BASE" | sed -E 's#^https?://([^/]+).*$#\1#')"
if [[ "$base_host" != "$BETTERSTACK_ALLOWED_HOST" ]]; then
  echo "Blocked BetterStack base host: $base_host (allowed: $BETTERSTACK_ALLOWED_HOST)" >&2
  exit 1
fi

url="${BETTERSTACK_API_BASE%/}${PATH_PART}"
url_host="$(printf '%s' "$url" | sed -E 's#^https?://([^/]+).*$#\1#')"
if [[ "$url_host" != "$BETTERSTACK_ALLOWED_HOST" ]]; then
  echo "Blocked BetterStack URL host: $url_host (allowed: $BETTERSTACK_ALLOWED_HOST)" >&2
  exit 1
fi

if [[ -n "$JSON_FILE" ]]; then
  if [[ ! -f "$JSON_FILE" ]]; then
    echo "JSON file not found: $JSON_FILE" >&2
    exit 1
  fi
  curl -fsS -X "$METHOD" \
    -H "Authorization: Bearer ${BETTERSTACK_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "$url" \
    --data @"$JSON_FILE"
else
  curl -fsS -X "$METHOD" \
    -H "Authorization: Bearer ${BETTERSTACK_API_TOKEN}" \
    "$url"
fi
