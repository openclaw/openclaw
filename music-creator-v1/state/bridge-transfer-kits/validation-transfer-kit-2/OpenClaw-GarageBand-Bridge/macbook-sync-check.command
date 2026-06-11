#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
PROBE_DIR="${BRIDGE_ROOT}/sync/mac-studio"
REPLY_DIR="${BRIDGE_ROOT}/sync/macbook"
STATUS_DIR="${BRIDGE_ROOT}/from-macbook"
LOG_DIR="${BRIDGE_ROOT}/logs"
STATUS_FILE="${STATUS_DIR}/macbook-sync-status.json"
LOG_FILE="${LOG_DIR}/macbook-sync-check.log"

mkdir -p "${PROBE_DIR}" "${REPLY_DIR}" "${STATUS_DIR}" "${LOG_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

json_escape() {
  printf "%s" "$1" | /usr/bin/sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

json_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null | /usr/bin/tr -d '\n' || true
}

safe_id() {
  [[ "$1" =~ '^[A-Za-z0-9._:-]+$' ]]
}

LATEST_PROBE="$(ls -t "${PROBE_DIR}"/*.json(N) 2>/dev/null | /usr/bin/head -n 1 || true)"
if [[ -z "${LATEST_PROBE}" ]]; then
  cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "blocked_no_probe",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "remoteLoginUsed": false,
  "nextAction": "On the Mac Studio, run bridge-sync-probe, wait for sync, then run this command again."
}
JSON
  echo "No Mac Studio sync probe found."
  exit 1
fi

PROBE_ID="$(json_value "${LATEST_PROBE}" "probeId")"
if ! safe_id "${PROBE_ID}"; then
  echo "Unsafe or missing probe id in ${LATEST_PROBE}"
  exit 1
fi

COMPUTER_NAME="$(scutil --get ComputerName 2>/dev/null | /usr/bin/tr -d '\n' || hostname)"
REPLY_FILE="${REPLY_DIR}/${PROBE_ID}.json"
cat > "${REPLY_FILE}" <<JSON
{
  "schemaVersion": 1,
  "probeId": "$(json_escape "${PROBE_ID}")",
  "status": "macbook_reply_written",
  "seenProbeFile": "sync/mac-studio/${PROBE_ID}.json",
  "replyFile": "sync/macbook/${PROBE_ID}.json",
  "computerName": "$(json_escape "${COMPUTER_NAME}")",
  "macUser": "$(whoami)",
  "remoteLoginUsed": false,
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
JSON

cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "reply_written",
  "probeId": "$(json_escape "${PROBE_ID}")",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "remoteLoginUsed": false,
  "replyFile": "sync/macbook/${PROBE_ID}.json",
  "nextAction": "On the Mac Studio, run bridge-sync-status to verify the reply synced back."
}
JSON

open "${BRIDGE_ROOT}" >/dev/null 2>&1 || true
echo "MacBook sync reply written for probe: ${PROBE_ID}"
echo "Reply file: ${REPLY_FILE}"
