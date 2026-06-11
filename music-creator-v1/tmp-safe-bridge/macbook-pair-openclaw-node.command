#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
STATUS_DIR="${BRIDGE_ROOT}/from-macbook"
LOG_DIR="${BRIDGE_ROOT}/logs"
STATUS_FILE="${STATUS_DIR}/macbook-node-status.json"
BLOCKERS_FILE="${STATUS_DIR}/macbook-node-blockers.txt"
LOG_FILE="${LOG_DIR}/macbook-pair-openclaw-node.log"
GATEWAY_HOST="100.103.214.120"
GATEWAY_PORT="18789"
GATEWAY_TLS="false"
TOKEN_MODE="prompt"
NODE_DISPLAY_NAME="GarageBand MacBook"

mkdir -p "${STATUS_DIR}" "${LOG_DIR}"
: > "${BLOCKERS_FILE}"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "OpenClaw MacBook node pairing started at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Gateway: ${GATEWAY_HOST}:${GATEWAY_PORT}"

record_blocker() {
  printf "%s\n" "$1" >> "${BLOCKERS_FILE}"
}

OPENCLAW_BIN=""
OPENCLAW_REPO=""

if command -v openclaw >/dev/null 2>&1; then
  OPENCLAW_BIN="$(command -v openclaw)"
else
  osascript -e 'display dialog "The openclaw CLI was not found on this MacBook. Choose the local OpenClaw repo folder if it exists; otherwise install OpenClaw on this MacBook first." buttons {"Choose Folder"} default button "Choose Folder"'
  OPENCLAW_REPO="$(osascript -e 'POSIX path of (choose folder with prompt "Choose the OpenClaw repo folder on this MacBook")')"
  if [[ ! -f "${OPENCLAW_REPO}/package.json" ]]; then
    record_blocker "Selected folder does not look like an OpenClaw repo."
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    record_blocker "pnpm is not installed or not on PATH, and openclaw CLI is unavailable."
  fi
fi

run_openclaw() {
  if [[ -n "${OPENCLAW_BIN}" ]]; then
    "${OPENCLAW_BIN}" "$@"
  else
    pnpm --dir "${OPENCLAW_REPO}" openclaw "$@"
  fi
}

BLOCKER_COUNT="$(wc -l < "${BLOCKERS_FILE}" | tr -d ' ')"
if [[ "${BLOCKER_COUNT}" != "0" ]]; then
  cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "blocked",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "gatewayHost": "${GATEWAY_HOST}",
  "gatewayPort": ${GATEWAY_PORT},
  "gatewayTls": ${GATEWAY_TLS},
  "nodeDisplayName": "${NODE_DISPLAY_NAME}",
  "tokenMode": "${TOKEN_MODE}",
  "blockerCount": ${BLOCKER_COUNT},
  "blockersFile": "from-macbook/macbook-node-blockers.txt",
  "setupLog": "logs/macbook-pair-openclaw-node.log"
}
JSON
  open "${BLOCKERS_FILE}"
  exit 1
fi

GATEWAY_TOKEN=""
if [[ "${TOKEN_MODE}" == "prompt" ]]; then
  GATEWAY_TOKEN="$(osascript -e 'text returned of (display dialog "Paste the Mac Studio OpenClaw Gateway token. It will be passed directly to openclaw node install and will not be written into the iCloud bridge status files." default answer "" with hidden answer buttons {"Continue"} default button "Continue")')"
  if [[ -z "${GATEWAY_TOKEN}" ]]; then
    record_blocker "Gateway token was not provided."
  fi
else
  echo "Using tokenless enrollment window mode. Make sure macstudio-open-node-enrollment.command is running on the Mac Studio."
fi

INSTALL_OUTPUT=""
START_OUTPUT=""
STATUS_OUTPUT=""
PAIRING_STATUS="pending_approval"

if [[ -s "${BLOCKERS_FILE}" ]]; then
  PAIRING_STATUS="blocked"
else
  set +e
  TLS_ARGS=()
  if [[ "${GATEWAY_TLS}" == "true" ]]; then
    TLS_ARGS=(--tls)
  fi
  if [[ "${GATEWAY_TLS}" != "true" && "${GATEWAY_HOST}" != "127.0.0.1" && "${GATEWAY_HOST}" != "localhost" ]]; then
    export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1
  fi
  if [[ "${TOKEN_MODE}" == "prompt" ]]; then
    export OPENCLAW_GATEWAY_TOKEN="${GATEWAY_TOKEN}"
  else
    unset OPENCLAW_GATEWAY_TOKEN
    unset OPENCLAW_GATEWAY_PASSWORD
  fi
  INSTALL_OUTPUT="$(run_openclaw node install --host "${GATEWAY_HOST}" --port "${GATEWAY_PORT}" "${TLS_ARGS[@]}" --display-name "${NODE_DISPLAY_NAME}" --force --json 2>&1)"
  INSTALL_CODE=$?
  START_OUTPUT="$(run_openclaw node start --json 2>&1)"
  START_CODE=$?
  STATUS_OUTPUT="$(run_openclaw node status --json 2>&1)"
  STATUS_CODE=$?
  unset OPENCLAW_GATEWAY_TOKEN
  unset OPENCLAW_ALLOW_INSECURE_PRIVATE_WS
  set -e

  printf "%s\n" "${INSTALL_OUTPUT}" > "${LOG_DIR}/macbook-node-install.json"
  printf "%s\n" "${START_OUTPUT}" > "${LOG_DIR}/macbook-node-start.json"
  printf "%s\n" "${STATUS_OUTPUT}" > "${LOG_DIR}/macbook-node-status-raw.json"

  if [[ "${INSTALL_CODE}" != "0" ]]; then
    record_blocker "openclaw node install failed."
    PAIRING_STATUS="blocked"
  elif [[ "${START_CODE}" != "0" ]]; then
    record_blocker "openclaw node start failed."
    PAIRING_STATUS="blocked"
  elif [[ "${STATUS_CODE}" != "0" ]]; then
    record_blocker "openclaw node status failed."
    PAIRING_STATUS="started_status_unknown"
  fi
fi

BLOCKER_COUNT="$(wc -l < "${BLOCKERS_FILE}" | tr -d ' ')"
if [[ "${BLOCKER_COUNT}" != "0" ]]; then
  PAIRING_STATUS="blocked"
fi

cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "${PAIRING_STATUS}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "gatewayHost": "${GATEWAY_HOST}",
  "gatewayPort": ${GATEWAY_PORT},
  "gatewayTls": ${GATEWAY_TLS},
  "nodeDisplayName": "${NODE_DISPLAY_NAME}",
  "tokenMode": "${TOKEN_MODE}",
  "privateWsOptIn": true,
  "gatewayTokenWrittenToBridge": false,
  "blockerCount": ${BLOCKER_COUNT},
  "blockersFile": "from-macbook/macbook-node-blockers.txt",
  "installLog": "logs/macbook-node-install.json",
  "startLog": "logs/macbook-node-start.json",
  "statusLog": "logs/macbook-node-status-raw.json",
  "setupLog": "logs/macbook-pair-openclaw-node.log",
  "nextAction": "On the Mac Studio, run openclaw nodes pending/list and approve the GarageBand MacBook node request."
}
JSON

open "${BRIDGE_ROOT}"
if [[ "${PAIRING_STATUS}" == "blocked" ]]; then
  open "${BLOCKERS_FILE}"
  osascript -e 'display dialog "OpenClaw node setup is blocked. The blockers file is open." buttons {"OK"} default button "OK"'
else
  osascript -e 'display dialog "OpenClaw node setup ran. Now approve the pending GarageBand MacBook node request on the Mac Studio." buttons {"OK"} default button "OK"'
fi

echo "MacBook node pairing status: ${PAIRING_STATUS}"
echo "Status file: ${STATUS_FILE}"
