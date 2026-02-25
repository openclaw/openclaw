#!/usr/bin/env bash
set -euo pipefail

cd /repo

export ACTIVI_STATE_DIR="/tmp/activi-test"
export ACTIVI_CONFIG_PATH="${ACTIVI_STATE_DIR}/activi.json"

echo "==> Build"
pnpm build

echo "==> Seed state"
mkdir -p "${ACTIVI_STATE_DIR}/credentials"
mkdir -p "${ACTIVI_STATE_DIR}/agents/main/sessions"
echo '{}' >"${ACTIVI_CONFIG_PATH}"
echo 'creds' >"${ACTIVI_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${ACTIVI_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm activi reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${ACTIVI_CONFIG_PATH}"
test ! -d "${ACTIVI_STATE_DIR}/credentials"
test ! -d "${ACTIVI_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${ACTIVI_STATE_DIR}/credentials"
echo '{}' >"${ACTIVI_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm activi uninstall --state --yes --non-interactive

test ! -d "${ACTIVI_STATE_DIR}"

echo "OK"
