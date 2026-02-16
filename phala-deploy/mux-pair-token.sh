#!/usr/bin/env bash
# Issue a mux pairing token for a channel.
#
# Usage:
#   ./phala-deploy/mux-pair-token.sh telegram
#   ./phala-deploy/mux-pair-token.sh discord
#   ./phala-deploy/mux-pair-token.sh whatsapp
#   ./phala-deploy/mux-pair-token.sh telegram <sessionKey>
#
# Auto-reads CVM IDs from .env.rollout-targets and MUX_ADMIN_TOKEN from vault.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CHANNEL="${1:-}"
SESSION_KEY="${2:-}"
TTL_SEC="${TTL_SEC:-900}"
INBOUND_TIMEOUT_MS="${INBOUND_TIMEOUT_MS:-15000}"

die() {
  printf '\033[1;31m[mux-pair-token] ERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

log() {
  printf '\033[1;34m[mux-pair-token]\033[0m %s\n' "$*"
}

if [[ -z "$CHANNEL" || "$CHANNEL" == "-h" || "$CHANNEL" == "--help" ]]; then
  sed -n '2,/^[^#]/{ /^#/s/^# \?//p }' "$0"
  exit 1
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_cmd curl
require_cmd jq
require_cmd phala
require_cmd rv-exec

# ── load config ──────────────────────────────────────────────────────────────

ENV_FILE="${SCRIPT_DIR}/.env.rollout-targets"
[[ -f "$ENV_FILE" ]] || die "config not found: ${ENV_FILE}"
set -a; source "$ENV_FILE"; set +a

OPENCLAW_CVM_ID="${PHALA_OPENCLAW_CVM_IDS:?set PHALA_OPENCLAW_CVM_IDS in .env.rollout-targets}"
MUX_CVM_ID="${PHALA_MUX_CVM_IDS:?set PHALA_MUX_CVM_IDS in .env.rollout-targets}"

# ── resolve endpoints from CVM info ─────────────────────────────────────────

resolve_base_from_cvm() {
  local cvm_id="$1" port_suffix="$2"
  local json app_id base_domain
  json="$(phala cvms get "$cvm_id" --json 2>/dev/null)"
  app_id="$(printf '%s' "$json" | jq -r '.app_id // empty')"
  base_domain="$(printf '%s' "$json" | jq -r '.gateway.base_domain // empty')"
  [[ -n "$app_id" && -n "$base_domain" ]] || die "failed to resolve endpoint for CVM ${cvm_id}"
  printf 'https://%s-%s.%s' "$app_id" "$port_suffix" "$base_domain"
}

log "Resolving endpoints..."
MUX_BASE_URL="$(resolve_base_from_cvm "$MUX_CVM_ID" "18891")"
OPENCLAW_INBOUND_URL="$(resolve_base_from_cvm "$OPENCLAW_CVM_ID" "18789")/v1/mux/inbound"

OPENCLAW_JSON="$(phala cvms get "$OPENCLAW_CVM_ID" --json 2>/dev/null)"
OPENCLAW_APP_ID="$(printf '%s' "$OPENCLAW_JSON" | jq -r '.app_id // empty')"
GATEWAY_DOMAIN="$(printf '%s' "$OPENCLAW_JSON" | jq -r '.gateway.base_domain // empty')"
[[ -n "$OPENCLAW_APP_ID" && -n "$GATEWAY_DOMAIN" ]] || die "failed to resolve gateway domain"
CVM_SSH_HOST="${OPENCLAW_APP_ID}-1022.${GATEWAY_DOMAIN}"

# ── resolve device ID ───────────────────────────────────────────────────────

log "Reading device ID from CVM..."
OPENCLAW_ID="$(CVM_SSH_HOST="$CVM_SSH_HOST" "$SCRIPT_DIR/cvm-exec" \
  'cat /root/.openclaw/identity/device.json' 2>/dev/null \
  | jq -r '.deviceId // empty' | tr -d '[:space:]')" \
  || die "failed to read device ID from CVM"
[[ -n "$OPENCLAW_ID" ]] || die "device ID is empty"

log "Channel:      ${CHANNEL}"
log "OpenClaw ID:  ${OPENCLAW_ID:0:16}..."
log "Mux URL:      ${MUX_BASE_URL}"
log "Inbound URL:  ${OPENCLAW_INBOUND_URL}"

# ── issue pairing token via rv-exec ──────────────────────────────────────────

pair_payload="$(jq -nc \
  --arg openclawId "$OPENCLAW_ID" \
  --arg inboundUrl "$OPENCLAW_INBOUND_URL" \
  --argjson inboundTimeoutMs "$INBOUND_TIMEOUT_MS" \
  --arg channel "$CHANNEL" \
  --arg sessionKey "$SESSION_KEY" \
  --argjson ttlSec "$TTL_SEC" \
  '{openclawId:$openclawId,inboundUrl:$inboundUrl,inboundTimeoutMs:$inboundTimeoutMs,channel:$channel,ttlSec:$ttlSec}
   + (if $sessionKey == "" then {} else {sessionKey:$sessionKey} end)')"

pair_response="$(rv-exec --project openclaw MUX_ADMIN_TOKEN -- bash -c '
  curl -fsS -X POST "'"${MUX_BASE_URL}"'/v1/admin/pairings/token" \
    -H "Authorization: Bearer ${MUX_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '"'${pair_payload}'"'
' 2>/dev/null)" || die "pairing token request failed"

echo ""
printf '%s\n' "$pair_response" | jq .

token="$(printf '%s' "$pair_response" | jq -r '.token // empty')"
start_cmd="$(printf '%s' "$pair_response" | jq -r '.startCommand // empty')"

echo ""
if [[ -n "$start_cmd" ]]; then
  log "Send to bot: ${start_cmd}"
elif [[ -n "$token" ]]; then
  log "Token: ${token}"
fi
