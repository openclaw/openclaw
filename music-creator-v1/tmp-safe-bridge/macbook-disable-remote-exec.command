#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
STATUS_DIR="${BRIDGE_ROOT}/from-macbook"
LOG_DIR="${BRIDGE_ROOT}/logs"
STATUS_FILE="${STATUS_DIR}/macbook-remote-exec-removed.json"
LOG_FILE="${LOG_DIR}/macbook-disable-remote-exec.log"
AUTHORIZED_KEYS="${HOME}/.ssh/authorized_keys"
BACKUP_FILE="${HOME}/.ssh/authorized_keys.backup-openclaw-disable-$(date -u +"%Y%m%dT%H%M%SZ")"

mkdir -p "${STATUS_DIR}" "${LOG_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

REMOVED_KEY=false
REMOTE_LOGIN_TEXT="$(/usr/sbin/systemsetup -getremotelogin 2>/dev/null || true)"

if [[ -f "${AUTHORIZED_KEYS}" ]]; then
  cp "${AUTHORIZED_KEYS}" "${BACKUP_FILE}"
  /usr/bin/grep -v "openclaw-garageband-bridge" "${BACKUP_FILE}" > "${AUTHORIZED_KEYS}" || true
  chmod 600 "${AUTHORIZED_KEYS}"
  if ! /usr/bin/cmp -s "${AUTHORIZED_KEYS}" "${BACKUP_FILE}"; then
    REMOVED_KEY=true
  fi
fi

cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "remote_exec_removed",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "removedOpenClawSshKeyLine": ${REMOVED_KEY},
  "remoteLoginState": "${REMOTE_LOGIN_TEXT}",
  "remoteLoginManagedByThisBridge": false,
  "nextAction": "Keep Remote Login off in System Settings > General > Sharing. Use macbook-pull-agent.command for safer automation."
}
JSON

open "${BRIDGE_ROOT}"
osascript -e 'display dialog "OpenClaw Remote Login key cleanup is complete. Keep Remote Login off and use the pull agent for safer automation." buttons {"OK"} default button "OK"' || true
echo "OpenClaw Remote Login key cleanup complete."
echo "Status file: ${STATUS_FILE}"
