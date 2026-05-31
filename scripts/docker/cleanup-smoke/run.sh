#!/usr/bin/env bash
set -euo pipefail

cd /repo

export OPENCLAW_STATE_DIR="/tmp/openclaw-test"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_STATE_DIR}/openclaw.json"

echo "==> Build"
if ! pnpm build >/tmp/openclaw-cleanup-build.log 2>&1; then
  cat /tmp/openclaw-cleanup-build.log
  exit 1
fi

echo "==> Seed state"
mkdir -p "${OPENCLAW_STATE_DIR}/credentials"
mkdir -p "${OPENCLAW_STATE_DIR}/agents/main/agent"
echo '{}' >"${OPENCLAW_CONFIG_PATH}"
echo 'creds' >"${OPENCLAW_STATE_DIR}/credentials/marker.txt"
echo 'session-db' >"${OPENCLAW_STATE_DIR}/agents/main/agent/openclaw-agent.sqlite"

echo "==> Reset (config+creds+sessions)"
if ! pnpm openclaw reset --scope config+creds+sessions --yes --non-interactive >/tmp/openclaw-cleanup-reset.log 2>&1; then
  cat /tmp/openclaw-cleanup-reset.log
  exit 1
fi

test ! -f "${OPENCLAW_CONFIG_PATH}"
test ! -d "${OPENCLAW_STATE_DIR}/credentials"
test ! -f "${OPENCLAW_STATE_DIR}/agents/main/agent/openclaw-agent.sqlite"

echo "==> Recreate minimal config"
mkdir -p "${OPENCLAW_STATE_DIR}/credentials"
echo '{}' >"${OPENCLAW_CONFIG_PATH}"

echo "==> Uninstall (state only)"
if ! pnpm openclaw uninstall --state --yes --non-interactive >/tmp/openclaw-cleanup-uninstall.log 2>&1; then
  cat /tmp/openclaw-cleanup-uninstall.log
  exit 1
fi

test ! -d "${OPENCLAW_STATE_DIR}"

echo "OK"
