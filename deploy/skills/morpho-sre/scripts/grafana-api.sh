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
  GRAFANA_ALLOWED_HOST (optional; must match base URL host when set)
  K8S_CONTEXT (optional; used to infer allowed host by env)

Host policy:
  - dev context => monitoring-dev.morpho.dev
  - prd/prod context => monitoring.morpho.dev
EOF
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

METHOD="$1"
PATH_PART="$2"
JSON_FILE="${3:-}"

if [[ -z "${GRAFANA_BASE_URL:-}" || -z "${GRAFANA_TOKEN:-}" ]]; then
  echo "Missing required env: GRAFANA_BASE_URL, GRAFANA_TOKEN" >&2
  exit 1
fi

if [[ "$PATH_PART" != /* ]]; then
  echo "PATH must start with / (got: $PATH_PART)" >&2
  exit 1
fi

BASE_HOST="$(printf '%s' "$GRAFANA_BASE_URL" | sed -E 's#^https?://([^/]+).*$#\1#')"

infer_host_from_context() {
  local ctx="${K8S_CONTEXT:-}"
  if [[ -z "$ctx" ]] && command -v kubectl >/dev/null 2>&1; then
    ctx="$(kubectl config current-context 2>/dev/null || true)"
  fi
  if [[ "$ctx" =~ (prd|prod) ]]; then
    printf '%s\n' "monitoring.morpho.dev"
    return 0
  fi
  if [[ "$ctx" =~ (dev|staging|sandbox) ]]; then
    printf '%s\n' "monitoring-dev.morpho.dev"
    return 0
  fi
  printf '%s\n' ""
}

ALLOWED_HOST="${GRAFANA_ALLOWED_HOST:-}"
if [[ -z "$ALLOWED_HOST" ]]; then
  CONTEXT_HOST="$(infer_host_from_context)"
  if [[ -n "$CONTEXT_HOST" ]]; then
    ALLOWED_HOST="$CONTEXT_HOST"
  else
    ALLOWED_HOST="monitoring-dev.morpho.dev"
  fi
fi

CONTEXT_HOST="$(infer_host_from_context)"
if [[ -n "$CONTEXT_HOST" && "$BASE_HOST" != "$CONTEXT_HOST" ]]; then
  echo "Blocked Grafana base URL host: $BASE_HOST (context expects: $CONTEXT_HOST)" >&2
  exit 1
fi
if [[ "$BASE_HOST" != "$ALLOWED_HOST" ]]; then
  echo "Blocked Grafana base URL host: $BASE_HOST (allowed: $ALLOWED_HOST)" >&2
  exit 1
fi

URL="${GRAFANA_BASE_URL%/}${PATH_PART}"
URL_HOST="$(printf '%s' "$URL" | sed -E 's#^https?://([^/]+).*$#\1#')"
if [[ "$URL_HOST" != "$ALLOWED_HOST" ]]; then
  echo "Blocked Grafana URL host: $URL_HOST (allowed: $ALLOWED_HOST)" >&2
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
