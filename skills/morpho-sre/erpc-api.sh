#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  erpc-api.sh <METHOD> <CHAIN_ID_OR_URL> [JSON_FILE]

Examples:
  erpc-api.sh GET '1'
  erpc-api.sh POST '8453' /tmp/payload.json
  erpc-api.sh POST 'https://rpc.morpho.dev/cache/evm/1' /tmp/payload.json

Env:
  FLO_TEST_API_KEY (required)
  ERPC_API_BASE (optional; default: https://rpc.morpho.dev)
  ERPC_PATH_PREFIX (optional; default: /cache/evm)
  ERPC_CURL_BIN (optional; default: curl)
  ERPC_ALLOWED_HOSTS (optional; comma-separated host allowlist; default: rpc.morpho.dev)
EOF
}

die() {
  echo "$*" >&2
  exit 1
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

METHOD="$1"
TARGET="$2"
JSON_FILE="${3:-}"
ERPC_CURL_BIN="${ERPC_CURL_BIN:-curl}"
ERPC_API_BASE="${ERPC_API_BASE:-https://rpc.morpho.dev}"
ERPC_PATH_PREFIX="${ERPC_PATH_PREFIX:-/cache/evm}"
ERPC_ALLOWED_HOSTS="${ERPC_ALLOWED_HOSTS:-rpc.morpho.dev}"

[[ -n "${FLO_TEST_API_KEY:-}" ]] || die "Missing required env: FLO_TEST_API_KEY"
command -v "$ERPC_CURL_BIN" >/dev/null 2>&1 || die "Missing curl binary: $ERPC_CURL_BIN"

resolve_url() {
  local target="$1"
  if [[ "$target" =~ ^https?:// ]]; then
    printf '%s\n' "$target"
    return 0
  fi
  if [[ "$target" =~ ^[0-9]+$ ]]; then
    printf '%s%s/%s\n' "${ERPC_API_BASE%/}" "${ERPC_PATH_PREFIX}" "$target"
    return 0
  fi
  die "Target must be numeric chainId or absolute URL (got: $target)"
}

extract_host() {
  local url="$1"
  printf '%s\n' "$url" | sed -E 's#^https?://([^/?#]+).*$#\1#'
}

enforce_allowed_host() {
  local url="$1"
  local allowed_raw="${ERPC_ALLOWED_HOSTS}"
  [[ -n "$allowed_raw" ]] || return 0
  local host
  host="$(extract_host "$url")"
  local normalized
  normalized="$(printf '%s' "$allowed_raw" | tr ',' ' ')"
  local allowed
  for allowed in $normalized; do
    allowed="$(printf '%s' "$allowed" | xargs)"
    [[ -z "$allowed" ]] && continue
    if [[ "$host" == "$allowed" ]]; then
      return 0
    fi
  done
  die "Blocked eRPC host: $host (allowed: $allowed_raw)"
}

with_secret_query() {
  local url="$1"
  local key="$2"
  local base="$url"
  local fragment=""
  if [[ "$base" == *"#"* ]]; then
    fragment="#${base#*#}"
    base="${base%%#*}"
  fi

  local path="$base"
  local query=""
  if [[ "$base" == *"?"* ]]; then
    path="${base%%\?*}"
    query="${base#*\?}"
  fi

  local rebuilt=""
  local part=""
  local remaining="$query"
  while [[ -n "$remaining" ]]; do
    if [[ "$remaining" == *"&"* ]]; then
      part="${remaining%%&*}"
      remaining="${remaining#*&}"
    else
      part="$remaining"
      remaining=""
    fi
    [[ -z "$part" ]] && continue
    if [[ "$part" == secret=* ]]; then
      continue
    fi
    if [[ -n "$rebuilt" ]]; then
      rebuilt="${rebuilt}&"
    fi
    rebuilt="${rebuilt}${part}"
  done

  if [[ -n "$rebuilt" ]]; then
    rebuilt="${rebuilt}&"
  fi
  rebuilt="${rebuilt}secret=${key}"
  printf '%s?%s%s\n' "$path" "$rebuilt" "$fragment"
}

URL="$(resolve_url "$TARGET")"
URL="$(with_secret_query "$URL" "$FLO_TEST_API_KEY")"
enforce_allowed_host "$URL"

if [[ -n "$JSON_FILE" ]]; then
  [[ -f "$JSON_FILE" ]] || die "JSON file not found: $JSON_FILE"
  "$ERPC_CURL_BIN" -fsS -X "$METHOD" \
    -H "Content-Type: application/json" \
    "$URL" \
    --data @"$JSON_FILE"
else
  "$ERPC_CURL_BIN" -fsS -X "$METHOD" "$URL"
fi
