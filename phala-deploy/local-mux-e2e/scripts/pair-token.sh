#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"
OPENCLAW_INBOUND_INTERNAL="http://openclaw:18789/v1/mux/inbound"
: "${MUX_ADMIN_TOKEN:=local-mux-e2e-admin-token}"
: "${MUX_BASE_URL:=http://127.0.0.1:18891}"

CHANNEL="${1:-}"
SESSION_KEY="${2:-}"
TTL_SEC="${TTL_SEC:-900}"

if [[ -z "${CHANNEL}" ]]; then
  echo "usage: $0 <telegram|discord|whatsapp> [sessionKey]" >&2
  exit 1
fi

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

# OpenClaw creates a device identity on first boot and persists it under
# /root/.openclaw/identity/device.json (symlinked to /data/openclaw in the CVM image).
# We use deviceId as the stable openclawId for mux runtime auth.
openclaw_id="$(
  compose exec -T openclaw node - <<'NODE'
const fs = require("fs");
const raw = fs.readFileSync("/root/.openclaw/identity/device.json", "utf8");
const parsed = JSON.parse(raw);
if (!parsed || typeof parsed.deviceId !== "string" || !parsed.deviceId.trim()) {
  throw new Error("missing deviceId");
}
process.stdout.write(parsed.deviceId.trim());
NODE
)"

if [[ -z "${openclaw_id}" ]]; then
  echo "[local-mux-e2e] failed to resolve openclawId from container identity" >&2
  exit 1
fi

payload="$(jq -nc \
  --arg channel "${CHANNEL}" \
  --arg sessionKey "${SESSION_KEY}" \
  --arg openclawId "${openclaw_id}" \
  --arg inboundUrl "${OPENCLAW_INBOUND_INTERNAL}" \
  --argjson ttlSec "${TTL_SEC}" \
  '{channel:$channel,ttlSec:$ttlSec,openclawId:$openclawId,inboundUrl:$inboundUrl,inboundTimeoutMs:15000}
   + (if $sessionKey == "" then {} else {sessionKey:$sessionKey} end)
  ')"

response="$(curl -sS -X POST "${MUX_BASE_URL}/v1/admin/pairings/token" \
  -H "Authorization: Bearer ${MUX_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${payload}")"

echo "${response}" | jq .

token="$(echo "${response}" | jq -r '.token // empty')"
if [[ -n "${token}" ]]; then
  echo "[local-mux-e2e] token: ${token}"
fi
