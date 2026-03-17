#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke runner for Telegram thread model inheritance:
# 1) Send `/model <set-model>` in thread A as user (MTProto).
# 2) Send `/model` in thread B as user.
# 3) Poll bot updates through tg (Bot API) and assert thread B reports expected model.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_CTL="${ROOT_DIR}/scripts/telegram-live-runtime.sh"
HELPER_MODULE="${ROOT_DIR}/scripts/lib/telegram-live-runtime-helpers.mjs"
# shellcheck source=scripts/telegram-e2e/userbot-common.sh
source "${SCRIPT_DIR}/userbot-common.sh"

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
  TG_BOT_TOKEN         bot token (`tg --token ...` + sender-id derive for fallback)
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

load_userbot_env_if_present

load_lane_env_if_present() {
  if [[ -f "${ROOT_DIR}/.telegram-lane.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ROOT_DIR}/.telegram-lane.env"
    set +a
  fi
  if [[ -f "${ROOT_DIR}/.env.local" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ROOT_DIR}/.env.local"
    set +a
  fi
}

if [[ -z "${TELEGRAM_API_ID:-}" || -z "${TELEGRAM_API_HASH:-}" || -z "${TG_BIN:-}" ]]; then
  echo "Missing required env vars (TELEGRAM_API_ID, TELEGRAM_API_HASH, TG_BIN)." >&2
  usage
  exit 1
fi

if [[ ! -x "${TG_BIN}" ]]; then
  echo "TG_BIN is not executable: ${TG_BIN}" >&2
  exit 1
fi

# Hard gate: ensure this worktree owns Telegram runtime before live assertions.
if ! "${RUNTIME_CTL}" ensure; then
  echo "FAIL: canonical runtime proof gate failed; aborting live assertions." >&2
  exit 1
fi

# Canonical runtime claim lives in the worktree root `.env.local`. Prefer that
# claimed tester bot token over any static bot token stored in Telegram E2E env.
if [[ -f "${ROOT_DIR}/.env.local" ]]; then
  claimed_bot_token="$(awk -F= '
    /^[[:space:]]*(export[[:space:]]+)?TELEGRAM_BOT_TOKEN[[:space:]]*=/ {
      value=$0
      sub(/^[^=]*=/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      gsub(/^'\''|'\''$/, "", value)
      token=value
    }
    END {
      if (token != "") {
        print token
      }
    }
  ' "${ROOT_DIR}/.env.local")"
  if [[ -n "${claimed_bot_token:-}" ]]; then
    TG_BOT_TOKEN="${claimed_bot_token}"
    export TG_BOT_TOKEN
  fi
fi

on_exit() {
  local status=$?
  trap - EXIT
  if ! "${RUNTIME_CTL}" handoff-main; then
    echo "WARN: handoff-main failed (exit status preserved: ${status})" >&2
  fi
  exit "$status"
}
trap on_exit EXIT

EXPECT_MODEL="${EXPECT_MODEL:-${SET_MODEL}}"
USERBOT_PYTHON="$(ensure_userbot_python)"
USERBOT_SESSION="$(resolve_userbot_session_path)"
run_userbot_precheck "${USERBOT_PYTHON}" "${USERBOT_SESSION}" "${CHAT}"

TG_POLL_ATTEMPTS="${TG_POLL_ATTEMPTS:-10}"
TG_POLL_TIMEOUT="${TG_POLL_TIMEOUT:-20}"
TG_POLL_SLEEP="${TG_POLL_SLEEP:-2}"
TG_BOT_ID=""
if [[ -n "${TG_BOT_TOKEN:-}" ]]; then
  TG_BOT_ID="${TG_BOT_TOKEN%%:*}"
fi

send_user_message() {
  local text="$1"
  local reply_to="$2"
  run_userbot_send "${USERBOT_PYTHON}" "${USERBOT_SESSION}" "${CHAT}" "${reply_to}" "${text}"
}

wait_userbot_message() {
  local after_id="$1"
  local thread_anchor="$2"
  local contains="$3"
  local timeout="$4"
  local sender_id="${5:-0}"

  local wait_cmd=(
    "${USERBOT_PYTHON}" "${SCRIPT_DIR}/userbot_wait.py"
    --api-id "${TELEGRAM_API_ID}" \
    --api-hash "${TELEGRAM_API_HASH}" \
    --session "${USERBOT_SESSION}" \
    --chat "${CHAT}" \
    --after-id "${after_id}" \
    --thread-anchor "${thread_anchor}" \
    --contains "${contains}" \
    --timeout "${timeout}"
  )
  if [[ "${sender_id}" -gt 0 ]]; then
    wait_cmd+=(--sender-id "${sender_id}")
  fi
  "${wait_cmd[@]}"
}

tg_poll_json() {
  if [[ -n "${TG_BOT:-}" ]]; then
    "${TG_BIN}" --bot "${TG_BOT}" poll --json --save-offset --timeout "${TG_POLL_TIMEOUT}"
  elif [[ -n "${TG_BOT_TOKEN:-}" ]]; then
    "${TG_BIN}" --token "${TG_BOT_TOKEN}" poll --json --save-offset --timeout "${TG_POLL_TIMEOUT}"
  else
    "${TG_BIN}" poll --json --save-offset --timeout "${TG_POLL_TIMEOUT}"
  fi
}

clear_target_thread_session_state() {
  # Live inheritance checks must make thread B look new to the isolated
  # worktree runtime. Reused topics are fine, but stale per-thread session state
  # would otherwise make the assertion non-deterministic across reruns.
  local reset_output=""
  reset_output="$(
    WORKTREE_PATH="${ROOT_DIR}" \
    TARGET_CHAT_ID="${CHAT}" \
    TARGET_THREAD_ID="${THREAD_B_ID}" \
    HELPER_MODULE="${HELPER_MODULE}" \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const helperPath = process.env.HELPER_MODULE;
const worktreePath = process.env.WORKTREE_PATH;
const chatId = process.env.TARGET_CHAT_ID;
const threadId = process.env.TARGET_THREAD_ID;

if (!helperPath || !worktreePath || !chatId || !threadId) {
  throw new Error("missing session reset inputs");
}

const helpers = await import(pathToFileURL(helperPath).href);
const profile = helpers.deriveTelegramLiveRuntimeProfile({ worktreePath });
const sessionsPath = path.join(profile.runtimeStateDir, "agents", "main", "sessions", "sessions.json");

if (!fs.existsSync(sessionsPath)) {
  process.stdout.write("0\n");
  process.exit(0);
}

const parsed = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
const result = helpers.pruneTelegramThreadSessions({
  agentId: "main",
  chatId,
  threadId,
  sessions: parsed,
});

if (result.removedKeys.length > 0) {
  fs.writeFileSync(sessionsPath, `${JSON.stringify(result.sessions, null, 2)}\n`, "utf8");
}

process.stdout.write(`${result.removedKeys.length}\n`);
NODE
  )"
  echo "thread_b_session_reset_count=${reset_output:-0}"
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
    ' <<<"${payload}" >/dev/null 2>&1
}

echo "Step 1: set model in thread A (${THREAD_A_REPLY_TO}) -> ${SET_MODEL}"
set_payload="$(send_user_message "/model ${SET_MODEL}" "${THREAD_A_REPLY_TO}")"
set_msg_id="$(jq -er '.message_id // 0' <<<"${set_payload}" 2>/dev/null || echo 0)"

echo "Reset thread B isolated session state so it behaves like a new thread"
clear_target_thread_session_state

echo "Step 2: query model in thread B (${THREAD_B_REPLY_TO})"
query_payload="$(send_user_message "/model" "${THREAD_B_REPLY_TO}")"
query_msg_id="$(jq -er '.message_id // 0' <<<"${query_payload}" 2>/dev/null || echo 0)"

echo "Step 3: poll bot updates and assert thread B reports ${EXPECT_MODEL}"
attempt=1
tg_conflict=0
while [[ "${attempt}" -le "${TG_POLL_ATTEMPTS}" ]]; do
  echo "Polling attempt ${attempt}/${TG_POLL_ATTEMPTS}..."
  payload="$(tg_poll_json 2>&1 || true)"
  if [[ "${payload}" == *"409 Conflict"* ]]; then
    echo "tg poll conflict detected (gateway owns getUpdates). Switching to userbot assertion fallback..."
    tg_conflict=1
    break
  fi
  if ! jq -e . >/dev/null 2>&1 <<<"${payload}"; then
    echo "tg poll returned non-JSON output. Switching to userbot assertion fallback..."
    tg_conflict=1
    break
  fi
  if [[ -n "${payload}" ]] && find_thread_text "${payload}" "Current:[[:space:]]+${EXPECT_MODEL}"; then
    echo "PASS: thread B reports expected model (${EXPECT_MODEL})"
    exit 0
  fi
  sleep "${TG_POLL_SLEEP}"
  attempt=$((attempt + 1))
done

if [[ "${tg_conflict}" -eq 1 ]]; then
  fallback_timeout=$((TG_POLL_ATTEMPTS * (TG_POLL_TIMEOUT + TG_POLL_SLEEP)))
  if wait_userbot_message "${query_msg_id}" "${THREAD_B_REPLY_TO}" "Current: ${EXPECT_MODEL}" "${fallback_timeout}" "${TG_BOT_ID:-0}" >/dev/null; then
    echo "PASS: thread B reports expected model (${EXPECT_MODEL}) [userbot fallback]"
    exit 0
  fi
  if wait_userbot_message "${query_msg_id}" "0" "Current: ${EXPECT_MODEL}" "${fallback_timeout}" "${TG_BOT_ID:-0}" >/dev/null; then
    echo "PASS: thread B reports expected model (${EXPECT_MODEL}) [userbot fallback, unanchored]"
    exit 0
  fi
fi

echo "FAIL: did not observe \"Current: ${EXPECT_MODEL}\" in thread B updates (set_msg_id=${set_msg_id}, query_msg_id=${query_msg_id})." >&2
exit 1
