#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HELPER_MODULE="${SCRIPT_DIR}/lib/telegram-live-runtime-helpers.mjs"
ASSIGN_BOT_SCRIPT="${SCRIPT_DIR}/assign-bot.sh"
MAIN_RECOVER_SCRIPT="${SCRIPT_DIR}/gateway-recover-main.sh"

WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
if [[ -d "$WORKTREE" ]]; then
  WORKTREE="$(cd "$WORKTREE" && pwd -P)"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
BASE_CONFIG_PATH="${OPENCLAW_TELEGRAM_BASE_CONFIG_PATH:-${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}}"

PROFILE_ID=""
RUNTIME_PORT=""
RUNTIME_STATE_DIR=""
RUNTIME_LOG_PATH=""
RUNTIME_PID=""
RUNTIME_WORKTREE=""
RUNTIME_OWNERSHIP="fail"
RUNTIME_HEALTH="fail"
RUNTIME_START_ACTION="not-started"
TOKEN_PRESENT="no"
TOKEN_POOL_GUARD="fail"
TOKEN_FINGERPRINT="none"
FAIL=0
FAIL_REASONS=()

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

add_failure() {
  local reason="$1"
  FAIL=1
  FAIL_REASONS+=("$reason")
}

resolve_profile() {
  if [[ ! -f "$HELPER_MODULE" ]]; then
    add_failure "helper_missing:${HELPER_MODULE}"
    return
  fi

  local state_root="${OPENCLAW_TELEGRAM_LIVE_STATE_ROOT:-}"
  local profile_lines
  profile_lines="$(
    WORKTREE_PATH="$WORKTREE" STATE_ROOT="$state_root" node --input-type=module - "$HELPER_MODULE" <<'NODE'
import { pathToFileURL } from "node:url";

const [helperPath] = process.argv.slice(2);
const helpers = await import(pathToFileURL(helperPath).href);
const profile = helpers.deriveTelegramLiveRuntimeProfile({
  worktreePath: process.env.WORKTREE_PATH,
  stateRoot: process.env.STATE_ROOT || undefined,
});

process.stdout.write(`${profile.profileId}\n${String(profile.runtimePort)}\n${profile.runtimeStateDir}\n`);
NODE
  )"

  PROFILE_ID="$(printf '%s\n' "$profile_lines" | sed -n '1p')"
  RUNTIME_PORT="$(printf '%s\n' "$profile_lines" | sed -n '2p')"
  RUNTIME_STATE_DIR="$(printf '%s\n' "$profile_lines" | sed -n '3p')"
  RUNTIME_LOG_PATH="/tmp/openclaw-telegram-live-${PROFILE_ID}.log"

  if [[ -z "$PROFILE_ID" || -z "$RUNTIME_PORT" || -z "$RUNTIME_STATE_DIR" ]]; then
    add_failure "profile_resolution_failed"
  fi
}

resolve_runtime_owner() {
  RUNTIME_PID=""
  RUNTIME_WORKTREE=""
  RUNTIME_OWNERSHIP="fail"

  if [[ -z "$RUNTIME_PORT" ]]; then
    return
  fi

  local pids
  pids="$(lsof -nP -tiTCP:"${RUNTIME_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  local count
  count="$(printf '%s\n' "$pids" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

  if [[ "$count" == "0" ]]; then
    return
  fi
  if [[ "$count" != "1" ]]; then
    add_failure "multiple_listeners_on_runtime_port:${RUNTIME_PORT}"
    return
  fi

  RUNTIME_PID="$(printf '%s\n' "$pids" | sed -n '1p' | tr -d '[:space:]')"
  if [[ -z "$RUNTIME_PID" ]]; then
    return
  fi

  local runtime_cmd
  runtime_cmd="$(ps -o command= -p "$RUNTIME_PID" 2>/dev/null || true)"
  RUNTIME_WORKTREE="$(lsof -a -p "$RUNTIME_PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p')"

  if [[ -n "$RUNTIME_WORKTREE" && "$RUNTIME_WORKTREE" == "$WORKTREE" ]] &&
    [[ "$runtime_cmd" == *" gateway run"* || "$runtime_cmd" == *"openclaw-gateway"* ]]; then
    RUNTIME_OWNERSHIP="ok"
  fi
}

probe_runtime_health() {
  RUNTIME_HEALTH="fail"
  if [[ -z "$RUNTIME_PORT" || -z "$RUNTIME_STATE_DIR" ]]; then
    return
  fi
  if env \
    OPENCLAW_STATE_DIR="$RUNTIME_STATE_DIR" \
    OPENCLAW_CONFIG_PATH="$BASE_CONFIG_PATH" \
    OPENCLAW_GATEWAY_PORT="$RUNTIME_PORT" \
    openclaw gateway status --deep --require-rpc >/tmp/openclaw-telegram-live-health.$$ 2>&1; then
    RUNTIME_HEALTH="ok"
  fi
}

ensure_tester_bot_claim() {
  if [[ ! -x "$ASSIGN_BOT_SCRIPT" ]]; then
    add_failure "assign_bot_script_missing:${ASSIGN_BOT_SCRIPT}"
    return
  fi

  if ! (cd "$REPO_ROOT" && bash "$ASSIGN_BOT_SCRIPT"); then
    add_failure "assign_bot_failed"
    return
  fi

  local env_local="${REPO_ROOT}/.env.local"
  local env_bots="${REPO_ROOT}/.env.bots"
  if [[ ! -f "$env_local" ]]; then
    add_failure "env_local_missing_after_assign"
    return
  fi
  if [[ ! -f "$env_bots" ]]; then
    add_failure "env_bots_missing_after_assign"
    return
  fi

  local token
  token="$(read_last_env_value "$env_local" "TELEGRAM_BOT_TOKEN")"
  if [[ -z "$token" ]]; then
    add_failure "telegram_token_missing_in_env_local"
    return
  fi

  TOKEN_PRESENT="yes"
  TOKEN_FINGERPRINT="$(mask_token "$token")"

  local in_pool="no"
  local line=""
  local trimmed=""
  local parsed=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "BOT_TOKEN" "$trimmed")"
    if [[ -n "$parsed" && "$parsed" == "$token" ]]; then
      in_pool="yes"
      break
    fi
  done < "$env_bots"

  if [[ "$in_pool" == "yes" ]]; then
    TOKEN_POOL_GUARD="ok"
  else
    TOKEN_POOL_GUARD="fail"
    add_failure "token_not_in_pool"
  fi
}

start_isolated_runtime() {
  mkdir -p "$RUNTIME_STATE_DIR"
  if nohup env \
    OPENCLAW_STATE_DIR="$RUNTIME_STATE_DIR" \
    OPENCLAW_CONFIG_PATH="$BASE_CONFIG_PATH" \
    OPENCLAW_GATEWAY_PORT="$RUNTIME_PORT" \
    pnpm openclaw gateway run --bind loopback --port "$RUNTIME_PORT" --force \
    >"$RUNTIME_LOG_PATH" 2>&1 & then
    RUNTIME_START_ACTION="started"
  else
    RUNTIME_START_ACTION="start-failed"
    add_failure "runtime_start_failed"
  fi
}

emit_ensure_proof_lines() {
  echo "branch=${BRANCH:-unknown}"
  echo "worktree=${WORKTREE}"
  echo "runtime_pid=${RUNTIME_PID:-}"
  echo "runtime_worktree=${RUNTIME_WORKTREE:-}"
  echo "runtime_port=${RUNTIME_PORT:-}"
  echo "runtime_state_dir=${RUNTIME_STATE_DIR:-}"
  echo "runtime_ownership=${RUNTIME_OWNERSHIP}"
  echo "runtime_health=${RUNTIME_HEALTH}"
  echo "runtime_start_action=${RUNTIME_START_ACTION}"
  echo "token_present=${TOKEN_PRESENT}"
  echo "token_pool_guard=${TOKEN_POOL_GUARD}"
  echo "token_fingerprint=${TOKEN_FINGERPRINT}"
}

ensure_command() {
  resolve_profile

  if [[ -z "${BRANCH}" || "${BRANCH}" == "HEAD" ]]; then
    add_failure "branch_detached_head"
  fi

  ensure_tester_bot_claim

  resolve_runtime_owner

  if [[ -n "$RUNTIME_PID" && "$RUNTIME_OWNERSHIP" != "ok" ]]; then
    add_failure "runtime_owned_by_other_worktree_or_process"
  fi

  if [[ -z "$RUNTIME_PID" && "$FAIL" -eq 0 ]]; then
    start_isolated_runtime
  fi

  if [[ "$FAIL" -eq 0 ]]; then
    local waited=0
    while [[ "$waited" -lt 60 ]]; do
      resolve_runtime_owner
      if [[ "$RUNTIME_OWNERSHIP" == "ok" ]]; then
        probe_runtime_health
        if [[ "$RUNTIME_HEALTH" == "ok" ]]; then
          break
        fi
      fi
      sleep 1
      waited=$((waited + 1))
    done
  fi

  if [[ "$RUNTIME_OWNERSHIP" != "ok" ]]; then
    add_failure "runtime_ownership_check_failed"
  fi
  if [[ "$RUNTIME_HEALTH" != "ok" ]]; then
    add_failure "runtime_health_check_failed"
  fi

  emit_ensure_proof_lines

  if [[ "$FAIL" -ne 0 ]]; then
    local reason
    for reason in "${FAIL_REASONS[@]-}"; do
      echo "error=${reason}" >&2
    done
    if [[ -n "$RUNTIME_LOG_PATH" ]]; then
      echo "runtime_log=${RUNTIME_LOG_PATH}" >&2
    fi
    return 1
  fi
}

stop_owned_runtime_if_present() {
  resolve_profile
  resolve_runtime_owner

  local stopped_pid=""
  local stop_result="skip"
  if [[ -n "$RUNTIME_PID" && "$RUNTIME_OWNERSHIP" == "ok" ]]; then
    stopped_pid="$RUNTIME_PID"
    if kill "$RUNTIME_PID" 2>/dev/null; then
      local waited=0
      while [[ "$waited" -lt 15 ]]; do
        if ! kill -0 "$RUNTIME_PID" 2>/dev/null; then
          break
        fi
        sleep 1
        waited=$((waited + 1))
      done
      if kill -0 "$RUNTIME_PID" 2>/dev/null; then
        kill -9 "$RUNTIME_PID" 2>/dev/null || true
      fi
      stop_result="ok"
    else
      stop_result="fail"
      add_failure "runtime_stop_failed"
    fi
  fi

  echo "handoff_worktree=${WORKTREE}"
  echo "handoff_runtime_port=${RUNTIME_PORT:-}"
  echo "handoff_stopped_pid=${stopped_pid}"
  echo "handoff_runtime_stop=${stop_result}"
}

handoff_main_command() {
  stop_owned_runtime_if_present

  local recover_result="fail"
  if [[ "$(uname -s)" != "Darwin" ]]; then
    recover_result="skip-non-darwin"
  elif [[ ! -x "$MAIN_RECOVER_SCRIPT" ]]; then
    recover_result="fail-missing-script"
    add_failure "main_recover_script_missing"
  elif "$MAIN_RECOVER_SCRIPT"; then
    recover_result="ok"
  else
    recover_result="fail"
    add_failure "main_recover_failed"
  fi

  echo "handoff_main_recover=${recover_result}"

  if [[ "$recover_result" != "ok" && "$recover_result" != "skip-non-darwin" ]]; then
    return 1
  fi
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/telegram-live-runtime.sh [ensure|handoff-main]

Commands:
  ensure       Validate and ensure isolated Telegram live runtime ownership for this worktree.
  handoff-main Stop isolated worktree runtime (if owned) and recover stable main runtime.
USAGE
}

main() {
  local cmd="${1:-ensure}"
  case "$cmd" in
    ensure)
      ensure_command
      ;;
    handoff-main)
      handoff_main_command
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
