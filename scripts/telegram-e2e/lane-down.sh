#!/usr/bin/env bash
set -euo pipefail

# Tears down an isolated Telegram live-test lane for the current worktree.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/telegram-e2e/lane-common.sh
source "${SCRIPT_DIR}/lane-common.sh"

RELEASE_TOKEN=0

usage() {
  cat <<'USAGE'
Usage:
  lane-down.sh [--release-token]

Options:
  --release-token   Remove TELEGRAM_BOT_TOKEN claim from .env.local.
                    If no entries remain, .env.local is deleted.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-token)
      RELEASE_TOKEN=1
      shift
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

if ! command -v openclaw >/dev/null 2>&1; then
  echo "Error: openclaw CLI is required in PATH." >&2
  exit 1
fi

resolve_lane_for_teardown() {
  local token=""
  token="$(lane_read_last_env_value "${TELEGRAM_LANE_ENV_LOCAL_FILE}" "TELEGRAM_BOT_TOKEN")"
  if [[ -n "${token}" ]]; then
    if lane_resolve_from_token_pool "${token}" >/dev/null 2>&1; then
      return 0
    fi
  fi

  if lane_load_metadata_file >/dev/null 2>&1; then
    LANE_PROFILE="${OPENCLAW_TG_LANE_PROFILE:-}"
    LANE_PORT="${OPENCLAW_TG_LANE_PORT:-}"
    LANE_SLOT="${OPENCLAW_TG_LANE_SLOT:-}"
    LANE_TOKEN_INDEX="${OPENCLAW_TG_LANE_TOKEN_INDEX:-}"
    LANE_TOKEN_FINGERPRINT="${OPENCLAW_TG_LANE_TOKEN_FINGERPRINT:-}"
    return 0
  fi

  return 1
}

release_token_claim() {
  local file_path="${TELEGRAM_LANE_ENV_LOCAL_FILE}"
  if [[ ! -f "${file_path}" ]]; then
    return 0
  fi

  local tmp_file=""
  tmp_file="$(mktemp -t openclaw-lane-down.XXXXXX)"

  # Keep all env entries except TELEGRAM_BOT_TOKEN claim.
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?TELEGRAM_BOT_TOKEN[[:space:]]*= ]]; then
      continue
    fi
    printf '%s\n' "$line" >> "${tmp_file}"
  done < "${file_path}"

  if grep -Eq '^[[:space:]]*[^#[:space:]]' "${tmp_file}" 2>/dev/null; then
    mv "${tmp_file}" "${file_path}"
  else
    rm -f "${tmp_file}"
    rm -f "${file_path}"
  fi
}

if ! resolve_lane_for_teardown; then
  echo "Error: unable to resolve lane profile from token pool or metadata." >&2
  exit 1
fi

if [[ -z "${LANE_PROFILE}" ]]; then
  echo "Error: lane profile is missing; cannot stop lane service." >&2
  exit 1
fi

openclaw --profile "${LANE_PROFILE}" gateway stop >/dev/null 2>&1 || true
rm -f "${TELEGRAM_LANE_METADATA_FILE}"

if [[ "${RELEASE_TOKEN}" == "1" ]]; then
  release_token_claim
  echo "lane down: ${LANE_PROFILE} (token claim released)"
else
  echo "lane down: ${LANE_PROFILE} (token claim retained)"
fi
