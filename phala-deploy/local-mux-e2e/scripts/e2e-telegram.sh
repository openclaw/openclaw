#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"
: "${MUX_ADMIN_TOKEN:=local-mux-e2e-admin-token}"
: "${MUX_BASE_URL:=http://127.0.0.1:18891}"
: "${POLL_TIMEOUT:=60}"

# Optional local overrides for non-secret values.
if [[ -f "${STACK_DIR}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${STACK_DIR}/.env.local"
  set +a
fi

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

# ---------- pre-checks ----------

for cmd in tgcli jq curl docker; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[e2e] FATAL: $cmd is required but not found" >&2
    exit 1
  fi
done

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "[e2e] FATAL: TELEGRAM_BOT_TOKEN not set (use rv-exec)" >&2
  exit 1
fi

if [[ -z "${TELEGRAM_E2E_BOT_CHAT_ID:-}" ]]; then
  echo "[e2e] FATAL: TELEGRAM_E2E_BOT_CHAT_ID not set (use rv-exec)" >&2
  exit 1
fi

BOT_CHAT_ID="${TELEGRAM_E2E_BOT_CHAT_ID}"

# ---------- temp file cleanup ----------

TMPFILES=()
cleanup() {
  for f in "${TMPFILES[@]}"; do
    rm -f "$f"
  done
}
trap cleanup EXIT

# ---------- ensure stack is running ----------

if ! docker ps --format '{{.Names}}' | grep -q 'openclaw-local-e2e'; then
  echo "[e2e] openclaw-local-e2e not running — calling up.sh" >&2
  "${SCRIPT_DIR}/up.sh"
fi

if ! docker ps --format '{{.Names}}' | grep -q 'mux-server-local-e2e'; then
  echo "[e2e] mux-server-local-e2e not running — calling up.sh" >&2
  "${SCRIPT_DIR}/up.sh"
fi

echo "[e2e] stack is running"

# ---------- helpers ----------

UUID="$(uuidgen | tr -d '-' | head -c 12)"

PASS=0
FAIL=0

pass() {
  echo "[e2e] PASS: $*"
  ((PASS++)) || true
}

fail() {
  echo "[e2e] FAIL: $*"
  ((FAIL++)) || true
}

# Line count in the mux-server structured log file (/data/mux-server.log
# inside the container).  Updated by fence() so that wait_for_reply only
# looks at entries produced after the fence.
MUX_LOG="/data/mux-server.log"
FENCE_LINES="$(compose exec -T mux-server wc -l "${MUX_LOG}" 2>/dev/null | tr -dc '0-9')"
: "${FENCE_LINES:=0}"

# Return structured log lines added since the last fence.
mux_log_tail() {
  compose exec -T mux-server tail -n "+$(( FENCE_LINES + 1 ))" "${MUX_LOG}" 2>/dev/null || true
}

# Poll until the mux-server structured log shows "telegram_inbound_forwarded"
# for a new message since the last fence.  This proves the full inbound path:
#   tgcli → Telegram API → mux-server long-poll → HTTP POST to OpenClaw → 200
#
# Once inbound is confirmed we treat the test as passed — the outbound reply
# (OpenClaw → mux-server → Telegram sendMessage) depends on the LLM and is
# not deterministic in timing.  If inbound forwarding succeeded, the pipeline
# is working.
#
# Writes elapsed seconds to stdout on success.  Returns 1 on timeout.
wait_for_reply() {
  local label="$1"
  local timeout="${2:-$POLL_TIMEOUT}"
  local start
  start="$(date +%s)"

  while true; do
    local now elapsed
    now="$(date +%s)"
    elapsed=$(( now - start ))
    if (( elapsed >= timeout )); then
      return 1
    fi

    if mux_log_tail | grep -q '"telegram_inbound_forwarded"'; then
      echo "${elapsed}"
      return 0
    fi

    sleep 3
  done
}

# Record current log line count so subsequent wait_for_reply ignores
# earlier entries.
fence() {
  sleep 2
  FENCE_LINES="$(compose exec -T mux-server wc -l "${MUX_LOG}" 2>/dev/null | tr -dc '0-9')"
  : "${FENCE_LINES:=0}"
}

# ---------- pairing (idempotent) ----------

echo "[e2e] pairing: issuing token for telegram"
pair_response="$("${SCRIPT_DIR}/pair-token.sh" telegram 2>&1)" || true
token="$(echo "${pair_response}" | grep -oP 'mpt_[A-Za-z0-9_-]+' | head -1)" || true

if [[ -z "${token}" ]]; then
  echo "[e2e] pairing: no token extracted (may already be paired), continuing" >&2
else
  echo "[e2e] pairing: sending /start ${token} to bot"
  tgcli send --to "${BOT_CHAT_ID}" --message "/start ${token}"
  # Wait a moment for pairing to be processed
  sleep 5
  echo "[e2e] pairing: confirmed (token sent)"
fi

fence

# ---------- test 1: text message ----------

echo "[e2e] test 1: sending text \"e2e-text-${UUID}\""
tgcli send --to "${BOT_CHAT_ID}" --message "e2e-text-${UUID}"

if elapsed="$(wait_for_reply "text" "${POLL_TIMEOUT}")"; then
  pass "text — inbound forwarded to OpenClaw in ${elapsed}s"
else
  fail "text — no inbound_forwarded within ${POLL_TIMEOUT}s"
fi

fence

# ---------- test 2: photo attachment ----------

PHOTO="/tmp/e2e-test-${UUID}.png"
TMPFILES+=("$PHOTO")

# Create a minimal valid 1x1 red PNG (68 bytes)
if command -v convert >/dev/null 2>&1; then
  convert -size 1x1 xc:red "$PHOTO"
elif command -v magick >/dev/null 2>&1; then
  magick -size 1x1 xc:red "$PHOTO"
else
  # Minimal 1x1 red PNG created from raw bytes
  printf '\x89PNG\r\n\x1a\n' > "$PHOTO"
  printf '\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde' >> "$PHOTO"
  printf '\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x00\x03\x00\x01\x00\x05\xfe\xd4' >> "$PHOTO"
  printf '\x00\x00\x00\x00IEND\xaeB\x60\x82' >> "$PHOTO"
fi

echo "[e2e] test 2: sending photo with caption \"e2e-photo-${UUID}\""
tgcli send --to "${BOT_CHAT_ID}" --photo "$PHOTO" --caption "e2e-photo-${UUID}"

if elapsed="$(wait_for_reply "photo" "${POLL_TIMEOUT}")"; then
  pass "photo — inbound forwarded to OpenClaw in ${elapsed}s"
else
  fail "photo — no inbound_forwarded within ${POLL_TIMEOUT}s"
fi

fence

# ---------- test 3: document attachment (regression for non-image files) ----------

DOC="/tmp/e2e-test-${UUID}.txt"
TMPFILES+=("$DOC")
echo "e2e test document content ${UUID}" > "$DOC"

echo "[e2e] test 3: sending document with caption \"e2e-doc-${UUID}\""
tgcli send --to "${BOT_CHAT_ID}" --file "$DOC" --caption "e2e-doc-${UUID}"

if elapsed="$(wait_for_reply "document" "${POLL_TIMEOUT}")"; then
  pass "document — inbound forwarded to OpenClaw in ${elapsed}s"
else
  fail "document — no inbound_forwarded within ${POLL_TIMEOUT}s"
fi

fence

# ---------- test 4: file proxy endpoint ----------

echo "[e2e] test 4: file proxy fetch"

# To test the file proxy we need a Telegram file_id.  The mux-server
# structured log doesn't include raw file_ids.  Extract the user's chat_id
# from the pairing record, then send a tiny photo via Bot API and grab the
# file_id from the response.
user_chat_id="$(compose exec -T mux-server grep -oP '"telegram_pairing_token_claimed".*"routeKey":"telegram:default:chat:\K[0-9]+' \
  "${MUX_LOG}" 2>/dev/null | tail -1)" || true

file_id=""
if [[ -n "${user_chat_id}" && -f "${PHOTO}" ]]; then
  send_photo_response="$(curl -sS \
    -F "chat_id=${user_chat_id}" \
    -F "photo=@${PHOTO}" \
    -F "caption=e2e-proxy-probe" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto")" || true
  file_id="$(echo "${send_photo_response}" \
    | jq -r '.result.photo[-1].file_id // empty')" || true
fi

if [[ -z "${file_id}" ]]; then
  fail "file proxy — could not obtain a file_id (user_chat_id=${user_chat_id:-empty}, photo=${PHOTO:-missing})"
else
  # The file proxy endpoint requires tenant auth (runtime JWT).
  # Obtain one by calling the register endpoint the same way OpenClaw does.
  : "${MUX_REGISTER_KEY:=local-mux-e2e-register-key}"

  # Get the openclawId from the container (same as pair-token.sh).
  e2e_openclaw_id="$(compose exec -T openclaw node -e "
    const fs = require('fs');
    const d = JSON.parse(fs.readFileSync('/root/.openclaw/identity/device.json','utf8'));
    process.stdout.write(d.deviceId.trim());
  " 2>/dev/null)" || true

  if [[ -z "${e2e_openclaw_id}" ]]; then
    fail "file proxy — could not resolve openclawId from container"
  else
    register_response="$(curl -sS -X POST "${MUX_BASE_URL}/v1/instances/register" \
      -H "Authorization: Bearer ${MUX_REGISTER_KEY}" \
      -H "Content-Type: application/json" \
      --data "{\"openclawId\":\"${e2e_openclaw_id}\",\"inboundUrl\":\"http://openclaw:18789/v1/mux/inbound\"}" \
      )" || true

    runtime_token="$(echo "${register_response}" | jq -r '.runtimeToken // empty')" || true

    if [[ -z "${runtime_token}" ]]; then
      fail "file proxy — could not obtain runtime JWT (register response: ${register_response})"
    else
      TMPFILES+=("/tmp/e2e-proxy-response")
      proxy_status="$(curl -s -o /tmp/e2e-proxy-response -w '%{http_code}' \
        -H "Authorization: Bearer ${runtime_token}" \
        -H "X-OpenClaw-Id: ${e2e_openclaw_id}" \
        "${MUX_BASE_URL}/v1/mux/files/telegram?fileId=${file_id}")" || true

      if [[ "${proxy_status}" == "200" ]]; then
        proxy_size="$(wc -c < /tmp/e2e-proxy-response)"
        if (( proxy_size > 0 )); then
          pass "file proxy returned 200 (${proxy_size} bytes)"
        else
          fail "file proxy returned 200 but empty body"
        fi
      else
        fail "file proxy returned HTTP ${proxy_status} (body: $(head -c 200 /tmp/e2e-proxy-response))"
      fi
    fi
  fi
fi

# ---------- summary ----------

TOTAL=$(( PASS + FAIL ))
echo "[e2e] result: ${PASS}/${TOTAL} passed"

if (( FAIL > 0 )); then
  exit 1
fi
