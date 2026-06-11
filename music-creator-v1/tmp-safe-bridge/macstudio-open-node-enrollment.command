#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
STATUS_DIR="${BRIDGE_ROOT}/from-macbook"
LOG_DIR="${BRIDGE_ROOT}/logs"
STATUS_FILE="${STATUS_DIR}/node-enrollment-window.json"
LOG_FILE="${LOG_DIR}/macstudio-open-node-enrollment.log"
OPENCLAW_REPO="/Users/openclaw/openclaw"
DURATION_SECONDS="${1:-600}"

mkdir -p "${STATUS_DIR}" "${LOG_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

run_openclaw() {
  pnpm --dir "${OPENCLAW_REPO}" openclaw "$@"
}

json_status() {
  local enrollment_status="$1"
  local next_action="$2"
  cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "${enrollment_status}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "durationSeconds": ${DURATION_SECONDS},
  "gatewayAuthTemporarilyDisabled": true,
  "gatewayTokenWrittenToBridge": false,
  "setupLog": "logs/macstudio-open-node-enrollment.log",
  "nextAction": "${next_action}"
}
JSON
}

PREVIOUS_AUTH_MODE="$(run_openclaw config get gateway.auth.mode 2>/dev/null | tail -n 1 | tr -d '\r')"
if [[ -z "${PREVIOUS_AUTH_MODE}" || "${PREVIOUS_AUTH_MODE}" == "__OPENCLAW_REDACTED__" ]]; then
  PREVIOUS_AUTH_MODE="token"
fi

RESTORED=false
restore_gateway_auth() {
  if [[ "${RESTORED}" == true ]]; then
    return
  fi
  RESTORED=true
  echo "Restoring Gateway auth mode to ${PREVIOUS_AUTH_MODE}."
  run_openclaw config set gateway.auth.mode "${PREVIOUS_AUTH_MODE}"
  run_openclaw gateway restart --json
  json_status "closed" "Enrollment window closed. Run openclaw nodes list and approve any pending GarageBand MacBook node request."
}

trap restore_gateway_auth EXIT INT TERM

echo "Opening short-lived tokenless node enrollment window for ${DURATION_SECONDS}s."
json_status "opening" "Wait for Gateway restart, then run macbook-pair-openclaw-node-window.command on the MacBook."
run_openclaw config set gateway.auth.mode none
run_openclaw gateway restart --json
json_status "open" "Run macbook-pair-openclaw-node-window.command on the MacBook before this window closes."
if [[ "${OPENCLAW_NODE_ENROLLMENT_NO_DIALOG:-}" != "1" ]]; then
  osascript -e 'display dialog "Node enrollment window is open. On the MacBook, run macbook-pair-openclaw-node-window.command from the synced bridge folder." buttons {"OK"} default button "OK"' || true
fi

END_AT=$(( $(date +%s) + DURATION_SECONDS ))
while [[ "$(date +%s)" -lt "${END_AT}" ]]; do
  run_openclaw nodes list --json > "${LOG_DIR}/nodes-list-during-enrollment.json" 2>&1 || true
  sleep 10
done

restore_gateway_auth
