#!/usr/bin/env bash
set -euo pipefail

cd /repo

export SMART_AGENT_NEO_STATE_DIR="/tmp/smart-agent-neo-test"
export SMART_AGENT_NEO_CONFIG_PATH="${SMART_AGENT_NEO_STATE_DIR}/smart-agent-neo.json"

echo "==> Build"
pnpm build

echo "==> Seed state"
mkdir -p "${SMART_AGENT_NEO_STATE_DIR}/credentials"
mkdir -p "${SMART_AGENT_NEO_STATE_DIR}/agents/main/sessions"
echo '{}' >"${SMART_AGENT_NEO_CONFIG_PATH}"
echo 'creds' >"${SMART_AGENT_NEO_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${SMART_AGENT_NEO_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm smart-agent-neo reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${SMART_AGENT_NEO_CONFIG_PATH}"
test ! -d "${SMART_AGENT_NEO_STATE_DIR}/credentials"
test ! -d "${SMART_AGENT_NEO_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${SMART_AGENT_NEO_STATE_DIR}/credentials"
echo '{}' >"${SMART_AGENT_NEO_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm smart-agent-neo uninstall --state --yes --non-interactive

test ! -d "${SMART_AGENT_NEO_STATE_DIR}"

echo "OK"
