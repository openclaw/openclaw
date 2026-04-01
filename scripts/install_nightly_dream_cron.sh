#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${1:-/root/.openclaw/workspace}"
CRON_EXPR="${CRON_EXPR:-30 2 * * *}"
CRON_TZ="${CRON_TZ:-Asia/Shanghai}"
THINKING="${THINKING:-low}"
MODEL="${MODEL:-}"
DISABLED="${DISABLED:-1}"
JOB_NAME="Nightly Dream Memory"
SECRETS_FILE="/root/.openclaw/openclaw-secrets.env"
JOBS_FILE="/root/.openclaw/cron/jobs.json"

if [[ ! -f "${SECRETS_FILE}" ]]; then
  echo "Missing secrets file: ${SECRETS_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${SECRETS_FILE}"

if [[ -z "${OPENCLAW_GATEWAY_AUTH_TOKEN:-}" ]]; then
  echo "OPENCLAW_GATEWAY_AUTH_TOKEN is not set in ${SECRETS_FILE}" >&2
  exit 1
fi

if [[ ! -f "${JOBS_FILE}" ]]; then
  echo "Missing jobs file: ${JOBS_FILE}" >&2
  exit 1
fi

EXISTING_ID="$(
  jq -r --arg name "${JOB_NAME}" '.jobs[] | select(.name == $name) | .id' "${JOBS_FILE}" | head -n 1
)"

MESSAGE="$(
  python3 "${WORKSPACE}/scripts/openclaw_harness.py" dream-cron-spec \
    --workspace "${WORKSPACE}" \
    --cron "${CRON_EXPR}" \
    --tz "${CRON_TZ}" \
    --thinking "${THINKING}" \
    --focus-current-task \
    --format json \
  | jq -r '.payload.message'
)"

BASE_ARGS=(
  --token "${OPENCLAW_GATEWAY_AUTH_TOKEN}"
  --name "${JOB_NAME}"
  --description "Claude-style nightly memory consolidation and reviewed promotion."
  --cron "${CRON_EXPR}"
  --tz "${CRON_TZ}"
  --session isolated
  --thinking "${THINKING}"
  --message "${MESSAGE}"
)

if [[ -n "${MODEL}" ]]; then
  BASE_ARGS+=(--model "${MODEL}")
fi

UPSERT_ARGS=(
  --jobs-file "${JOBS_FILE}"
  --name "${JOB_NAME}"
  --description "Claude-style nightly memory consolidation and reviewed promotion."
  --cron "${CRON_EXPR}"
  --tz "${CRON_TZ}"
  --thinking "${THINKING}"
  --message "${MESSAGE}"
)

if [[ -n "${MODEL}" ]]; then
  UPSERT_ARGS+=(--model "${MODEL}")
fi

if [[ "${DISABLED}" == "1" ]]; then
  UPSERT_ARGS+=(--disabled)
fi

restart_gateway() {
  if ! systemctl --user restart openclaw-gateway.service; then
    echo "warning: updated jobs.json but could not restart openclaw-gateway.service in this shell; restart it separately" >&2
  fi
}

if [[ -n "${EXISTING_ID}" ]]; then
  EDIT_ARGS=("${BASE_ARGS[@]}")
  if [[ "${DISABLED}" == "1" ]]; then
    EDIT_ARGS+=(--disable)
  else
    EDIT_ARGS+=(--enable)
  fi
  if ! openclaw cron edit "${EXISTING_ID}" "${EDIT_ARGS[@]}"; then
    python3 "${WORKSPACE}/scripts/upsert_nightly_dream_cron.py" "${UPSERT_ARGS[@]}"
    restart_gateway
  fi
else
  ADD_ARGS=("${BASE_ARGS[@]}")
  if [[ "${DISABLED}" == "1" ]]; then
    ADD_ARGS+=(--disabled)
  fi
  if ! openclaw cron add "${ADD_ARGS[@]}"; then
    python3 "${WORKSPACE}/scripts/upsert_nightly_dream_cron.py" "${UPSERT_ARGS[@]}"
    restart_gateway
  fi
fi
