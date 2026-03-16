#!/usr/bin/env bash

# Shared Telegram userbot helpers used by live validation scripts.
# Keep logic centralized here so wrappers remain thin and behavior stays consistent.

set -euo pipefail

readonly USERBOT_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly USERBOT_CANONICAL_SESSION="${USERBOT_COMMON_DIR}/tmp/userbot.session"
readonly USERBOT_LEGACY_SESSION="${USERBOT_COMMON_DIR}/userbot.session"

require_userbot_credentials() {
  local api_id="${TELEGRAM_API_ID:-}"
  local api_hash="${TELEGRAM_API_HASH:-}"

  if [[ -z "${api_id}" || -z "${api_hash}" ]]; then
    echo "E_MISSING_CREDS: TELEGRAM_API_ID and TELEGRAM_API_HASH are required." >&2
    return 10
  fi

  if ! [[ "${api_id}" =~ ^[0-9]+$ ]] || [[ "${api_id}" == "0" ]]; then
    echo "E_MISSING_CREDS: TELEGRAM_API_ID must be a positive integer." >&2
    return 10
  fi
}

load_userbot_env_if_present() {
  local env_local="${USERBOT_COMMON_DIR}/.env.local"
  if [[ -f "${env_local}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_local}"
    set +a
  fi
}

resolve_userbot_session_path() {
  if [[ -n "${USERBOT_SESSION:-}" ]]; then
    printf '%s\n' "${USERBOT_SESSION}"
    return 0
  fi

  if [[ -f "${USERBOT_CANONICAL_SESSION}" && -f "${USERBOT_LEGACY_SESSION}" ]]; then
    echo "E_AMBIGUOUS_SESSION: both session files exist (${USERBOT_CANONICAL_SESSION} and ${USERBOT_LEGACY_SESSION}). Set USERBOT_SESSION explicitly." >&2
    return 1
  fi

  if [[ -f "${USERBOT_CANONICAL_SESSION}" ]]; then
    printf '%s\n' "${USERBOT_CANONICAL_SESSION}"
    return 0
  fi

  if [[ -f "${USERBOT_LEGACY_SESSION}" ]]; then
    printf '%s\n' "${USERBOT_LEGACY_SESSION}"
    return 0
  fi

  # Default target path for deterministic missing-session checks.
  printf '%s\n' "${USERBOT_CANONICAL_SESSION}"
}

ensure_userbot_python() {
  local python_bin="${USERBOT_COMMON_DIR}/.venv/bin/python"

  # Healthy venv should be a no-op and stay quiet.
  if [[ -x "${python_bin}" ]] && "${python_bin}" -c "import telethon" >/dev/null 2>&1; then
    printf '%s\n' "${python_bin}"
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "E_PYTHON_MISSING: python3 is required for Telegram userbot scripts." >&2
    return 1
  fi

  if [[ ! -x "${python_bin}" ]]; then
    python3 -m venv "${USERBOT_COMMON_DIR}/.venv" >/dev/null 2>&1 || {
      echo "E_VENV_CREATE_FAILED: failed to create ${USERBOT_COMMON_DIR}/.venv." >&2
      return 1
    }
  fi

  if ! "${python_bin}" -c "import telethon" >/dev/null 2>&1; then
    if ! "${python_bin}" -m pip install --disable-pip-version-check -r "${USERBOT_COMMON_DIR}/requirements.txt" >/dev/null 2>&1; then
      echo "E_TELETHON_INSTALL_FAILED: could not install Telegram userbot dependencies." >&2
      return 1
    fi
  fi

  if ! "${python_bin}" -c "import telethon" >/dev/null 2>&1; then
    echo "E_TELETHON_INSTALL_FAILED: telethon import still failing after bootstrap." >&2
    return 1
  fi

  printf '%s\n' "${python_bin}"
}

run_userbot_precheck() {
  local python_bin="$1"
  local session_path="$2"
  local chat="$3"
  require_userbot_credentials

  "${python_bin}" "${USERBOT_COMMON_DIR}/userbot_precheck.py" \
    --api-id "${TELEGRAM_API_ID:-}" \
    --api-hash "${TELEGRAM_API_HASH:-}" \
    --session "${session_path}" \
    --chat "${chat}"
}

run_userbot_send() {
  local python_bin="$1"
  local session_path="$2"
  local chat="$3"
  local reply_to="$4"
  local text="$5"

  local send_err_file
  send_err_file="$(mktemp -t userbot-send.XXXXXX.err)"
  if ! "${python_bin}" "${USERBOT_COMMON_DIR}/userbot_send.py" \
    --api-id "${TELEGRAM_API_ID:-}" \
    --api-hash "${TELEGRAM_API_HASH:-}" \
    --session "${session_path}" \
    --chat "${chat}" \
    --reply-to "${reply_to}" \
    --text "${text}" 2>"${send_err_file}"; then
    rm -f "${send_err_file}"
    echo "E_USERBOT_SEND_FAILED: send failed; run userbot_precheck.py to validate session/chat." >&2
    return 1
  fi
  rm -f "${send_err_file}"
}

userbot_send_live_main() {
  local chat=""
  local text=""
  local reply_to="0"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --chat)
        chat="${2:-}"
        shift 2
        ;;
      --text)
        text="${2:-}"
        shift 2
        ;;
      --reply-to)
        reply_to="${2:-0}"
        shift 2
        ;;
      -h|--help)
        cat <<'USAGE'
Usage:
  userbot-send-live.sh --chat <chat> --text <text> [--reply-to <messageId>]
USAGE
        return 0
        ;;
      *)
        echo "Unknown arg: $1" >&2
        return 1
        ;;
    esac
  done

  if [[ -z "${chat}" || -z "${text}" ]]; then
    echo "Missing required args: --chat and --text." >&2
    return 1
  fi

  load_userbot_env_if_present
  require_userbot_credentials
  local python_bin
  python_bin="$(ensure_userbot_python)"
  local session_path
  session_path="$(resolve_userbot_session_path)"

  run_userbot_precheck "${python_bin}" "${session_path}" "${chat}"
  run_userbot_send "${python_bin}" "${session_path}" "${chat}" "${reply_to}" "${text}"
}
