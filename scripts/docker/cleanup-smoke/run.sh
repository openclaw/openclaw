#!/usr/bin/env bash
set -euo pipefail

cd /repo

export MULLUSI_STATE_DIR="/tmp/mullusi-test"
export MULLUSI_CONFIG_PATH="${MULLUSI_STATE_DIR}/mullusi.json"

echo "==> Build"
pnpm build

echo "==> Seed state"
mkdir -p "${MULLUSI_STATE_DIR}/credentials"
mkdir -p "${MULLUSI_STATE_DIR}/agents/main/sessions"
echo '{}' >"${MULLUSI_CONFIG_PATH}"
echo 'creds' >"${MULLUSI_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${MULLUSI_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm mullusi reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${MULLUSI_CONFIG_PATH}"
test ! -d "${MULLUSI_STATE_DIR}/credentials"
test ! -d "${MULLUSI_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${MULLUSI_STATE_DIR}/credentials"
echo '{}' >"${MULLUSI_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm mullusi uninstall --state --yes --non-interactive

test ! -d "${MULLUSI_STATE_DIR}"

echo "OK"
