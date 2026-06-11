#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
STATUS_DIR="${BRIDGE_ROOT}/from-macbook"
LOG_DIR="${BRIDGE_ROOT}/logs"
STATUS_FILE="${STATUS_DIR}/macbook-safe-bridge-status.json"
LOG_FILE="${LOG_DIR}/macbook-start-safe-bridge.log"

mkdir -p "${STATUS_DIR}" "${LOG_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

json_escape() {
  printf "%s" "$1" | /usr/bin/sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

write_status() {
  local bridge_status="$1"
  local detail="$2"
  cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "${bridge_status}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "remoteLoginUsed": false,
  "arbitraryCommandsAllowed": false,
  "detail": "$(json_escape "${detail}")",
  "nextAction": "On the Mac Studio, run bridge-sync-status and bridge-status."
}
JSON
}

REMOTE_LOGIN_TEXT="$(/usr/sbin/systemsetup -getremotelogin 2>/dev/null || true)"
if [[ "${REMOTE_LOGIN_TEXT}" == *"On"* ]]; then
  write_status "blocked_remote_login_on" "Remote Login is on. Turn it off in System Settings > General > Sharing, then run this command again."
  if [[ "${OPENCLAW_BRIDGE_NO_DIALOG:-}" != "1" ]]; then
    osascript -e 'display dialog "Remote Login is ON. For the safe bridge, turn it off in System Settings > General > Sharing, then run this command again." buttons {"OK"} default button "OK"' || true
  fi
  echo "Blocked: Remote Login is on."
  exit 1
fi

echo "Starting safe OpenClaw GarageBand bridge."
echo "Remote Login is not being used."
"${BRIDGE_ROOT}/macbook-sync-check.command"
"${BRIDGE_ROOT}/macbook-pull-agent.command" --once
write_status "safe_bridge_ran_once" "Sync check completed and one signed pull-agent cycle ran."
if [[ "${OPENCLAW_BRIDGE_NO_DIALOG:-}" != "1" ]]; then
  osascript -e 'display dialog "Safe OpenClaw GarageBand bridge ran once. Go back to the Mac Studio and verify bridge status." buttons {"OK"} default button "OK"' || true
fi
echo "Safe OpenClaw GarageBand bridge ran once."
