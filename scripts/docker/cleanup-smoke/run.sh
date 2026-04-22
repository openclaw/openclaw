#!/usr/bin/env bash
set -euo pipefail

cd /repo

RUN_PNPM_COMMAND="/repo/scripts/pre-commit/run-pnpm-command.sh"

export OPENCLAW_STATE_DIR="/tmp/openclaw-test"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_STATE_DIR}/openclaw.json"

echo "==> Build"
if ! "$RUN_PNPM_COMMAND" build >/tmp/openclaw-cleanup-build.log 2>&1; then
  cat /tmp/openclaw-cleanup-build.log
  exit 1
fi

echo "==> Seed state"
mkdir -p "${OPENCLAW_STATE_DIR}/credentials"
mkdir -p "${OPENCLAW_STATE_DIR}/agents/main/sessions"
echo '{}' >"${OPENCLAW_CONFIG_PATH}"
echo 'creds' >"${OPENCLAW_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${OPENCLAW_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
if ! "$RUN_PNPM_COMMAND" openclaw reset --scope config+creds+sessions --yes --non-interactive >/tmp/openclaw-cleanup-reset.log 2>&1; then
  cat /tmp/openclaw-cleanup-reset.log
  exit 1
fi

test ! -f "${OPENCLAW_CONFIG_PATH}"
test ! -d "${OPENCLAW_STATE_DIR}/credentials"
test ! -d "${OPENCLAW_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${OPENCLAW_STATE_DIR}/credentials"
echo '{}' >"${OPENCLAW_CONFIG_PATH}"

echo "==> Uninstall (state only)"
if ! "$RUN_PNPM_COMMAND" openclaw uninstall --state --yes --non-interactive >/tmp/openclaw-cleanup-uninstall.log 2>&1; then
  cat /tmp/openclaw-cleanup-uninstall.log
  exit 1
fi

test ! -d "${OPENCLAW_STATE_DIR}"

echo "OK"
