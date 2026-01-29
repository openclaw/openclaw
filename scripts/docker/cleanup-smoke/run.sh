#!/usr/bin/env bash
set -euo pipefail

cd /repo

export DNA_STATE_DIR="/tmp/dna-test"
export DNA_CONFIG_PATH="${DNA_STATE_DIR}/dna.json"

echo "==> Seed state"
mkdir -p "${DNA_STATE_DIR}/credentials"
mkdir -p "${DNA_STATE_DIR}/agents/main/sessions"
echo '{}' >"${DNA_CONFIG_PATH}"
echo 'creds' >"${DNA_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${DNA_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm dna reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${DNA_CONFIG_PATH}"
test ! -d "${DNA_STATE_DIR}/credentials"
test ! -d "${DNA_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${DNA_STATE_DIR}/credentials"
echo '{}' >"${DNA_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm dna uninstall --state --yes --non-interactive

test ! -d "${DNA_STATE_DIR}"

echo "OK"
