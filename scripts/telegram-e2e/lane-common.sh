#!/usr/bin/env bash

# Shared helpers for Telegram live E2E lane isolation.
# These helpers intentionally avoid printing raw bot tokens.

readonly TELEGRAM_LANE_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TELEGRAM_LANE_ROOT_DIR="$(cd "${TELEGRAM_LANE_COMMON_DIR}/../.." && pwd)"
readonly TELEGRAM_LANE_ENV_LOCAL_FILE="${TELEGRAM_LANE_ROOT_DIR}/.env.local"
readonly TELEGRAM_LANE_ENV_BOTS_FILE="${TELEGRAM_LANE_ROOT_DIR}/.env.bots"
readonly TELEGRAM_LANE_METADATA_FILE="${TELEGRAM_LANE_ROOT_DIR}/.telegram-lane.env"
readonly TELEGRAM_LANE_ASSIGN_BOT_SCRIPT="${TELEGRAM_LANE_ROOT_DIR}/scripts/assign-bot.sh"

# lane_* globals are intentionally shared across callers after lane_resolve_*.
LANE_SLOT=""
LANE_PROFILE=""
LANE_PORT=""
LANE_TOKEN_INDEX=""
LANE_TOKEN_FINGERPRINT=""
LANE_PORT_BASE=""
LANE_PORT_STEP=""

lane_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

lane_strip_outer_quotes() {
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

lane_parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(lane_trim "${BASH_REMATCH[2]}")"
    parsed="$(lane_strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

lane_read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  if [[ ! -f "$file_path" ]]; then
    printf '%s' ""
    return
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(lane_trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(lane_parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

lane_mask_token() {
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

lane_require_bot_token_assignment() {
  local token=""
  token="$(lane_read_last_env_value "${TELEGRAM_LANE_ENV_LOCAL_FILE}" "TELEGRAM_BOT_TOKEN")"
  if [[ -n "$token" ]]; then
    printf '%s' "$token"
    return 0
  fi

  if [[ ! -x "${TELEGRAM_LANE_ASSIGN_BOT_SCRIPT}" ]]; then
    echo "Error: missing assign script at ${TELEGRAM_LANE_ASSIGN_BOT_SCRIPT}" >&2
    return 1
  fi

  if [[ ! -r "${TELEGRAM_LANE_ENV_BOTS_FILE}" ]]; then
    echo "Error: ${TELEGRAM_LANE_ENV_BOTS_FILE} is required for token assignment." >&2
    return 1
  fi

  (
    cd "${TELEGRAM_LANE_ROOT_DIR}"
    bash "${TELEGRAM_LANE_ASSIGN_BOT_SCRIPT}"
  ) >/dev/null

  token="$(lane_read_last_env_value "${TELEGRAM_LANE_ENV_LOCAL_FILE}" "TELEGRAM_BOT_TOKEN")"
  if [[ -z "$token" ]]; then
    echo "Error: TELEGRAM_BOT_TOKEN missing after assignment." >&2
    return 1
  fi
  printf '%s' "$token"
}

lane_find_token_index_in_pool() {
  local token="$1"
  local line=""
  local trimmed=""
  local parsed=""
  local idx=0

  if [[ ! -r "${TELEGRAM_LANE_ENV_BOTS_FILE}" ]]; then
    printf '0'
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(lane_trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(lane_parse_env_assignment "BOT_TOKEN" "$trimmed")"
    if [[ -z "$parsed" ]]; then
      continue
    fi
    idx=$((idx + 1))
    if [[ "$parsed" == "$token" ]]; then
      printf '%s' "$idx"
      return 0
    fi
  done < "${TELEGRAM_LANE_ENV_BOTS_FILE}"

  printf '0'
  return 1
}

lane_positive_int_or_default() {
  local raw="$1"
  local fallback="$2"
  if [[ -z "${raw}" ]]; then
    printf '%s' "$fallback"
    return 0
  fi
  if [[ ! "${raw}" =~ ^[0-9]+$ ]]; then
    echo "Error: expected positive integer, got '${raw}'." >&2
    return 1
  fi
  if [[ "${raw}" == "0" ]]; then
    echo "Error: value must be greater than zero." >&2
    return 1
  fi
  printf '%s' "$raw"
}

# Resolve deterministic lane mapping from assigned token and token pool.
# Mapping:
#   slot = BOT_TOKEN position in .env.bots (1-based)
#   profile = tg-lane-<slot>
#   port = base + (slot - 1) * step
lane_resolve_from_token_pool() {
  local token="$1"
  local slot=""
  slot="$(lane_find_token_index_in_pool "$token")" || true
  if [[ -z "$slot" || "$slot" == "0" ]]; then
    echo "Error: assigned token is not present in ${TELEGRAM_LANE_ENV_BOTS_FILE}." >&2
    return 1
  fi

  LANE_PORT_BASE="$(lane_positive_int_or_default "${OPENCLAW_TG_LANE_PORT_BASE:-}" "19789")" || return 1
  LANE_PORT_STEP="$(lane_positive_int_or_default "${OPENCLAW_TG_LANE_PORT_STEP:-}" "20")" || return 1

  local lane_port=$((LANE_PORT_BASE + (slot - 1) * LANE_PORT_STEP))
  if (( lane_port <= 0 )); then
    echo "Error: computed lane port is invalid (${lane_port})." >&2
    return 1
  fi

  LANE_SLOT="$slot"
  LANE_TOKEN_INDEX="$slot"
  LANE_PROFILE="tg-lane-${slot}"
  LANE_PORT="${lane_port}"
  LANE_TOKEN_FINGERPRINT="$(lane_mask_token "$token")"
}

lane_write_metadata_file() {
  local branch="$1"
  local worktree="$2"
  {
    printf 'OPENCLAW_TG_LANE_SLOT=%s\n' "${LANE_SLOT}"
    printf 'OPENCLAW_TG_LANE_TOKEN_INDEX=%s\n' "${LANE_TOKEN_INDEX}"
    printf 'OPENCLAW_TG_LANE_PROFILE=%q\n' "${LANE_PROFILE}"
    printf 'OPENCLAW_TG_LANE_PORT=%s\n' "${LANE_PORT}"
    printf 'OPENCLAW_TG_LANE_PORT_BASE=%s\n' "${LANE_PORT_BASE}"
    printf 'OPENCLAW_TG_LANE_PORT_STEP=%s\n' "${LANE_PORT_STEP}"
    printf 'OPENCLAW_TG_LANE_TOKEN_FINGERPRINT=%q\n' "${LANE_TOKEN_FINGERPRINT}"
    printf 'OPENCLAW_TG_LANE_BRANCH=%q\n' "${branch}"
    printf 'OPENCLAW_TG_LANE_WORKTREE=%q\n' "${worktree}"
  } > "${TELEGRAM_LANE_METADATA_FILE}"
}

lane_load_metadata_file() {
  if [[ ! -f "${TELEGRAM_LANE_METADATA_FILE}" ]]; then
    return 1
  fi
  # Metadata file is script-generated and contains no command substitutions.
  # shellcheck disable=SC1090
  source "${TELEGRAM_LANE_METADATA_FILE}"
  return 0
}

lane_runtime_worktree_from_status_json() {
  local status_json="$1"
  local runtime_entry=""
  runtime_entry="$(
    jq -r '
      [
        .service.command.programArguments[]?
        | select(type == "string")
        | select(test("(^|/)dist/index\\.js$"))
      ][0] // empty
    ' <<<"${status_json}" 2>/dev/null
  )"

  if [[ -z "${runtime_entry}" ]]; then
    printf '%s' ""
    return
  fi

  printf '%s' "${runtime_entry%/dist/index.js}"
}
