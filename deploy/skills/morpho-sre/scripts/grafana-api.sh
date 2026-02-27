#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  grafana-api.sh <METHOD> <PATH> [JSON_FILE]

Examples:
  grafana-api.sh GET /api/health
  grafana-api.sh GET /api/search
  grafana-api.sh POST /api/dashboards/db dashboard.json

Env:
  GRAFANA_BASE_URL (required)
  GRAFANA_TOKEN (required)
  GRAFANA_ALLOWED_HOST (required; must match base URL host)
EOF
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

METHOD="$1"
PATH_PART="$2"
JSON_FILE="${3:-}"

if [[ -z "${GRAFANA_BASE_URL:-}" || -z "${GRAFANA_TOKEN:-}" || -z "${GRAFANA_ALLOWED_HOST:-}" ]]; then
  echo "Missing required env: GRAFANA_BASE_URL, GRAFANA_TOKEN, GRAFANA_ALLOWED_HOST" >&2
  exit 1
fi

if [[ "$PATH_PART" != /* ]]; then
  echo "PATH must start with / (got: $PATH_PART)" >&2
  exit 1
fi

BASE_HOST="$(printf '%s' "$GRAFANA_BASE_URL" | sed -E 's#^https?://([^/]+).*$#\1#')"
if [[ "$BASE_HOST" != "$GRAFANA_ALLOWED_HOST" ]]; then
  echo "Blocked Grafana base URL host: $BASE_HOST (allowed: $GRAFANA_ALLOWED_HOST)" >&2
  exit 1
fi

URL="${GRAFANA_BASE_URL%/}${PATH_PART}"
URL_HOST="$(printf '%s' "$URL" | sed -E 's#^https?://([^/]+).*$#\1#')"
if [[ "$URL_HOST" != "$GRAFANA_ALLOWED_HOST" ]]; then
  echo "Blocked Grafana URL host: $URL_HOST (allowed: $GRAFANA_ALLOWED_HOST)" >&2
  exit 1
fi

if [[ -n "$JSON_FILE" ]]; then
  if [[ ! -f "$JSON_FILE" ]]; then
    echo "JSON file not found: $JSON_FILE" >&2
    exit 1
  fi
  curl -fsS -X "$METHOD" \
    -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
    -H "Content-Type: application/json" \
    "$URL" \
    --data @"$JSON_FILE"
else
  curl -fsS -X "$METHOD" \
    -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
    "$URL"
fi
