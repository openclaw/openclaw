#!/usr/bin/env bash
set -euo pipefail

cd /repo

export EASYHUB_STATE_DIR="/tmp/EasyHub-test"
export EASYHUB_CONFIG_PATH="${EASYHUB_STATE_DIR}/easyhub.json"

echo "==> Build"
pnpm build

echo "==> Seed state"
mkdir -p "${EASYHUB_STATE_DIR}/credentials"
mkdir -p "${EASYHUB_STATE_DIR}/agents/main/sessions"
echo '{}' >"${EASYHUB_CONFIG_PATH}"
echo 'creds' >"${EASYHUB_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${EASYHUB_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm EasyHub reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${EASYHUB_CONFIG_PATH}"
test ! -d "${EASYHUB_STATE_DIR}/credentials"
test ! -d "${EASYHUB_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${EASYHUB_STATE_DIR}/credentials"
echo '{}' >"${EASYHUB_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm EasyHub uninstall --state --yes --non-interactive

test ! -d "${EASYHUB_STATE_DIR}"

echo "OK"
