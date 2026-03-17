#!/usr/bin/env bash
set -euo pipefail

# Bootstraps an isolated Telegram live-test lane for the current worktree.
# Lane identity is deterministic from BOT_TOKEN position in .env.bots.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/telegram-e2e/lane-common.sh
source "${SCRIPT_DIR}/lane-common.sh"

PREPARE_ONLY=0

usage() {
  cat <<'USAGE'
Usage:
  lane-up.sh [--prepare-only]

Options:
  --prepare-only   Only resolve token->lane mapping and write .telegram-lane.env
                   (no gateway install/start/health checks).

Env overrides:
  OPENCLAW_TG_LANE_PORT_BASE   Default: 19789
  OPENCLAW_TG_LANE_PORT_STEP   Default: 20
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prepare-only)
      PREPARE_ONLY=1
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
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required in PATH." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required in PATH." >&2
  exit 1
fi

WORKTREE="${TELEGRAM_LANE_ROOT_DIR}"
BRANCH="$(cd "${WORKTREE}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -z "${BRANCH}" || "${BRANCH}" == "HEAD" ]]; then
  echo "Error: live lane requires a named branch (detached HEAD is not allowed)." >&2
  exit 1
fi

# Ensure this worktree has an assigned bot token claim.
TOKEN="$(lane_require_bot_token_assignment)"
if [[ -z "${TOKEN}" ]]; then
  echo "Error: TELEGRAM_BOT_TOKEN is required in ${TELEGRAM_LANE_ENV_LOCAL_FILE}." >&2
  exit 1
fi

lane_resolve_from_token_pool "${TOKEN}"
lane_write_metadata_file "${BRANCH}" "${WORKTREE}"

if [[ "${PREPARE_ONLY}" == "1" ]]; then
  echo "lane metadata prepared: ${TELEGRAM_LANE_METADATA_FILE}"
  echo "branch=${BRANCH}"
  echo "runtime_worktree=${WORKTREE}"
  echo "profile=${LANE_PROFILE}"
  echo "port=${LANE_PORT}"
  echo "slot=${LANE_SLOT}"
  echo "token_fingerprint=${LANE_TOKEN_FINGERPRINT}"
  exit 0
fi

run_local_openclaw() {
  (
    cd "${WORKTREE}"
    node scripts/run-node.mjs "$@"
  )
}

start_lane_gateway() {
  if run_local_openclaw --profile "${LANE_PROFILE}" gateway start; then
    return 0
  fi

  # launchctl fallback: some environments report "service not loaded" immediately
  # after install even though the plist was written correctly.
  if [[ "${OSTYPE:-}" == darwin* ]] && command -v launchctl >/dev/null 2>&1; then
    local label="ai.openclaw.${LANE_PROFILE}"
    local plist="${HOME}/Library/LaunchAgents/${label}.plist"
    if [[ -f "${plist}" ]]; then
      launchctl bootstrap "gui/$(id -u)" "${plist}" 2>/dev/null || true
      if launchctl kickstart -k "gui/$(id -u)/${label}" >/dev/null 2>&1; then
        return 0
      fi
    fi
  fi

  return 1
}

wait_for_lane_rpc() {
  local timeout_seconds="${OPENCLAW_TG_LANE_RPC_TIMEOUT_SECONDS:-60}"
  local poll_seconds="${OPENCLAW_TG_LANE_RPC_POLL_SECONDS:-2}"
  if [[ ! "${timeout_seconds}" =~ ^[0-9]+$ ]] || [[ "${timeout_seconds}" == "0" ]]; then
    timeout_seconds=60
  fi
  if [[ ! "${poll_seconds}" =~ ^[0-9]+$ ]] || [[ "${poll_seconds}" == "0" ]]; then
    poll_seconds=2
  fi

  local started_at
  started_at="$(date +%s)"
  while true; do
    if openclaw --profile "${LANE_PROFILE}" gateway status --deep --require-rpc >/dev/null 2>&1; then
      return 0
    fi
    local now elapsed
    now="$(date +%s)"
    elapsed=$((now - started_at))
    if (( elapsed >= timeout_seconds )); then
      return 1
    fi
    sleep "${poll_seconds}"
  done
}

# Each isolated lane must force local gateway mode and its deterministic port.
# Without this, service start can be blocked by unset/non-local gateway.mode.
# Lane profiles are isolated, so we must also copy the assigned bot token into
# the profile config; otherwise Telegram updates arrive but no bot channel binds.
# Keep lane profiles deterministic by only allowing the Telegram plugin.
# This avoids unrelated plugin side effects while preserving real Telegram I/O.
run_local_openclaw --profile "${LANE_PROFILE}" config set gateway.mode local
run_local_openclaw --profile "${LANE_PROFILE}" config set gateway.port "${LANE_PORT}"
run_local_openclaw --profile "${LANE_PROFILE}" config set channels.telegram.botToken "${TOKEN}"
run_local_openclaw --profile "${LANE_PROFILE}" config set channels.telegram.enabled true
run_local_openclaw --profile "${LANE_PROFILE}" config set channels.telegram.groupPolicy open
run_local_openclaw --profile "${LANE_PROFILE}" config set plugins.enabled true
run_local_openclaw --profile "${LANE_PROFILE}" config set plugins.allow '["telegram"]'

run_local_openclaw --profile "${LANE_PROFILE}" gateway install --force --runtime node --port "${LANE_PORT}"

if ! start_lane_gateway; then
  echo "Error: failed to start lane gateway service for profile ${LANE_PROFILE}." >&2
  exit 1
fi

# Hard health gate for deterministic lane ownership.
if ! wait_for_lane_rpc; then
  echo "Error: lane gateway did not pass RPC health checks in time for profile ${LANE_PROFILE}." >&2
  exit 1
fi
status_json="$(openclaw --profile "${LANE_PROFILE}" gateway status --deep --json 2>/dev/null || true)"
if ! jq -e . >/dev/null 2>&1 <<<"${status_json}"; then
  echo "Error: failed to parse gateway status JSON for profile ${LANE_PROFILE}." >&2
  exit 1
fi

active_port="$(jq -r '.gateway.port // empty' <<<"${status_json}")"
rpc_ok="$(jq -r '.rpc.ok // false' <<<"${status_json}")"
runtime_worktree="$(lane_runtime_worktree_from_status_json "${status_json}")"
if [[ "${active_port}" != "${LANE_PORT}" ]]; then
  echo "Error: lane port mismatch (expected ${LANE_PORT}, got ${active_port:-unknown})." >&2
  exit 1
fi
if [[ "${rpc_ok}" != "true" ]]; then
  echo "Error: gateway RPC probe failed for lane profile ${LANE_PROFILE}." >&2
  exit 1
fi
if [[ -z "${runtime_worktree}" || "${runtime_worktree}" != "${WORKTREE}" ]]; then
  echo "Error: gateway runtime ownership mismatch (expected ${WORKTREE}, got ${runtime_worktree:-unknown})." >&2
  exit 1
fi

echo "lane up: ${LANE_PROFILE} (slot=${LANE_SLOT}, port=${LANE_PORT}, token=${LANE_TOKEN_FINGERPRINT})"
echo "branch=${BRANCH}"
echo "runtime_worktree=${runtime_worktree}"
echo "profile=${LANE_PROFILE}"
echo "port=${LANE_PORT}"
