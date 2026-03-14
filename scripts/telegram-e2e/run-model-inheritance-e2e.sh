#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke runner for Telegram thread model inheritance:
# 1) Send `/model <set-model>` in thread A as user (MTProto).
# 2) Send `/model` in thread B as user.
# 3) Poll bot updates through tg (Bot API) and assert thread B reports expected model.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CHAT=""
SET_MODEL=""
EXPECT_MODEL=""
THREAD_A_REPLY_TO=""
THREAD_B_REPLY_TO=""
THREAD_B_ID=""

usage() {
  cat <<'USAGE'
Usage:
  run-model-inheritance-e2e.sh \
    --chat <chat> \
    --set-model <provider/model> \
    --thread-a-reply-to <msgId> \
    --thread-b-reply-to <msgId> \
    --thread-b-id <threadId> \
    [--expect-model <provider/model>]

Required environment:
  TELEGRAM_API_ID      Telegram API ID for user MTProto session
  TELEGRAM_API_HASH    Telegram API hash for user MTProto session
  TG_BIN               Path to tg binary (from your tg fork build)

Optional environment:
  TG_BOT               tg bot alias, if you configured multiple bots
  TG_POLL_ATTEMPTS     Poll attempts (default: 10)
  TG_POLL_TIMEOUT      Per-poll timeout seconds (default: 20)
  TG_POLL_SLEEP        Sleep between polls seconds (default: 2)
  USERBOT_SESSION      Telethon session path
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat)
      CHAT="$2"
      shift 2
      ;;
    --set-model)
      SET_MODEL="$2"
      shift 2
      ;;
    --expect-model)
      EXPECT_MODEL="$2"
      shift 2
      ;;
    --thread-a-reply-to)
      THREAD_A_REPLY_TO="$2"
      shift 2
      ;;
    --thread-b-reply-to)
      THREAD_B_REPLY_TO="$2"
      shift 2
      ;;
    --thread-b-id)
      THREAD_B_ID="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${CHAT}" || -z "${SET_MODEL}" || -z "${THREAD_A_REPLY_TO}" || -z "${THREAD_B_REPLY_TO}" || -z "${THREAD_B_ID}" ]]; then
  usage
  exit 1
fi

if [[ -z "${TELEGRAM_API_ID:-}" || -z "${TELEGRAM_API_HASH:-}" || -z "${TG_BIN:-}" ]]; then
  echo "Missing required env vars (TELEGRAM_API_ID, TELEGRAM_API_HASH, TG_BIN)." >&2
  usage
  exit 1
fi

if [[ ! -x "${TG_BIN}" ]]; then
  echo "TG_BIN is not executable: ${TG_BIN}" >&2
  exit 1
fi

EXPECT_MODEL="${EXPECT_MODEL:-${SET_MODEL}}"
USERBOT_SESSION="${USERBOT_SESSION:-${SCRIPT_DIR}/tmp/userbot.session}"
TG_POLL_ATTEMPTS="${TG_POLL_ATTEMPTS:-10}"
TG_POLL_TIMEOUT="${TG_POLL_TIMEOUT:-20}"
TG_POLL_SLEEP="${TG_POLL_SLEEP:-2}"

send_user_message() {
  local text="$1"
  local reply_to="$2"
  python3 "${SCRIPT_DIR}/userbot_send.py" \
    --api-id "${TELEGRAM_API_ID}" \
    --api-hash "${TELEGRAM_API_HASH}" \
    --session "${USERBOT_SESSION}" \
    --chat "${CHAT}" \
    --reply-to "${reply_to}" \
    --text "${text}"
}

tg_poll_json() {
  if [[ -n "${TG_BOT:-}" ]]; then
    "${TG_BIN}" --bot "${TG_BOT}" poll --json --save-offset --timeout "${TG_POLL_TIMEOUT}"
  else
    "${TG_BIN}" poll --json --save-offset --timeout "${TG_POLL_TIMEOUT}"
  fi
}

find_thread_text() {
  local payload="$1"
  local needle="$2"
  jq -er \
    --argjson tid "${THREAD_B_ID}" \
    --arg needle "${needle}" \
    '
      [
        .. | objects | .message? // empty
        | select(
            (
              (.message_thread_id? // -1) == $tid
            ) or (
              (.direct_messages_topic?.topic_id? // -1) == $tid
            )
          )
        | .text? // empty
      ] | map(select(test($needle))) | length > 0
    ' <<<"${payload}" >/dev/null
}

echo "Step 1: set model in thread A (${THREAD_A_REPLY_TO}) -> ${SET_MODEL}"
send_user_message "/model ${SET_MODEL}" "${THREAD_A_REPLY_TO}" >/dev/null

echo "Step 2: query model in thread B (${THREAD_B_REPLY_TO})"
send_user_message "/model" "${THREAD_B_REPLY_TO}" >/dev/null

echo "Step 3: poll bot updates and assert thread B reports ${EXPECT_MODEL}"
attempt=1
while [[ "${attempt}" -le "${TG_POLL_ATTEMPTS}" ]]; do
  echo "Polling attempt ${attempt}/${TG_POLL_ATTEMPTS}..."
  payload="$(tg_poll_json || true)"
  if [[ -n "${payload}" ]] && find_thread_text "${payload}" "Current:[[:space:]]+${EXPECT_MODEL}"; then
    echo "PASS: thread B reports expected model (${EXPECT_MODEL})"
    exit 0
  fi
  sleep "${TG_POLL_SLEEP}"
  attempt=$((attempt + 1))
done

echo "FAIL: did not observe \"Current: ${EXPECT_MODEL}\" in thread B updates." >&2
exit 1
