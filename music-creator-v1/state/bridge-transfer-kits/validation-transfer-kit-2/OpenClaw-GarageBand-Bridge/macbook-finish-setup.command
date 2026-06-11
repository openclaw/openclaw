#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
STATUS_DIR="${BRIDGE_ROOT}/from-macbook"
LOG_DIR="${BRIDGE_ROOT}/logs"
STATUS_FILE="${STATUS_DIR}/macbook-prereq-status.json"
BLOCKERS_FILE="${STATUS_DIR}/macbook-prereq-blockers.txt"
LOG_FILE="${LOG_DIR}/macbook-finish-setup.log"
VALHALLA_DMG_URL="https://valhallaproduction.s3.us-west-2.amazonaws.com/supermassive/ValhallaSupermassiveOSX_5_0_0.dmg"
VALHALLA_DMG="/tmp/ValhallaSupermassiveOSX_5_0_0.dmg"
VALHALLA_AU="/Library/Audio/Plug-Ins/Components/ValhallaSupermassive.component"

mkdir -p "${STATUS_DIR}" "${LOG_DIR}"
: > "${BLOCKERS_FILE}"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "OpenClaw GarageBand bridge setup started at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

bool_for_path() {
  if [[ -e "$1" ]]; then
    echo true
  else
    echo false
  fi
}

record_blocker() {
  printf "%s\n" "$1" >> "${BLOCKERS_FILE}"
}

garageband_installed() {
  [[ -d "/Applications/GarageBand.app" || -d "/System/Applications/GarageBand.app" ]]
}

if ! garageband_installed; then
  echo "GarageBand is missing. Opening the Mac App Store page."
  open "macappstore://apps.apple.com/us/app/garageband/id682658836" || true
  osascript -e 'display dialog "GarageBand is not installed yet. The Mac App Store page is open. Install GarageBand, then click OK here to continue validation." buttons {"OK"} default button "OK"'
fi

GARAGEBAND_INSTALLED=false
if garageband_installed; then
  GARAGEBAND_INSTALLED=true
else
  record_blocker "GarageBand is still missing after setup prompt."
fi

VALHALLA_AU_INSTALLED="$(bool_for_path "${VALHALLA_AU}")"
if [[ "${VALHALLA_AU_INSTALLED}" != true ]]; then
  echo "Valhalla Supermassive system AU is missing. Downloading official installer."
  if [[ ! -s "${VALHALLA_DMG}" ]]; then
    curl -L --fail "${VALHALLA_DMG_URL}" -o "${VALHALLA_DMG}"
  fi

  MOUNT_POINT=""
  MOUNT_OUTPUT="$(hdiutil attach -nobrowse "${VALHALLA_DMG}")"
  MOUNT_POINT="$(printf "%s\n" "${MOUNT_OUTPUT}" | awk -F '\t' '/\/Volumes\// {print $NF}' | tail -n 1)"
  if [[ -n "${MOUNT_POINT}" && -d "${MOUNT_POINT}" ]]; then
    PKG_PATH="$(find "${MOUNT_POINT}" -maxdepth 2 -name "*.pkg" -print -quit)"
    if [[ -n "${PKG_PATH}" ]]; then
      echo "Opening Valhalla installer package. Complete the installer with admin approval."
      open "${PKG_PATH}"
      osascript -e 'display dialog "Complete the Valhalla Supermassive installer with admin approval. When the installer is finished, click OK to validate the Audio Unit." buttons {"OK"} default button "OK"'
    else
      record_blocker "Valhalla installer package was not found inside the mounted DMG."
    fi
    hdiutil detach "${MOUNT_POINT}" || true
  else
    record_blocker "Valhalla DMG could not be mounted."
  fi
fi

VALHALLA_AU_INSTALLED="$(bool_for_path "${VALHALLA_AU}")"
if [[ "${VALHALLA_AU_INSTALLED}" != true ]]; then
  record_blocker "Valhalla Supermassive system AU is still missing."
fi

AUVAL_PASSED=false
AUVAL_OUTPUT="$(auval -v aufx sMas oDin 2>&1 || true)"
printf "%s\n" "${AUVAL_OUTPUT}" > "${LOG_DIR}/valhalla-supermassive-auval.txt"
if printf "%s\n" "${AUVAL_OUTPUT}" | grep -qi "validation result: successfully validated"; then
  AUVAL_PASSED=true
else
  record_blocker "Valhalla Supermassive did not pass auval validation."
fi

if [[ "${GARAGEBAND_INSTALLED}" == true ]]; then
  open -a GarageBand || true
fi

BLOCKER_COUNT="$(wc -l < "${BLOCKERS_FILE}" | tr -d ' ')"
OVERALL_STATUS="ready"
if [[ "${BLOCKER_COUNT}" != "0" ]]; then
  OVERALL_STATUS="blocked"
fi

cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "${OVERALL_STATUS}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "garageBandInstalled": ${GARAGEBAND_INSTALLED},
  "valhallaSystemAuInstalled": ${VALHALLA_AU_INSTALLED},
  "valhallaAuvalPassed": ${AUVAL_PASSED},
  "blockerCount": ${BLOCKER_COUNT},
  "blockersFile": "from-macbook/macbook-prereq-blockers.txt",
  "auvalLog": "logs/valhalla-supermassive-auval.txt",
  "setupLog": "logs/macbook-finish-setup.log",
  "nextAction": "If status is ready, run macbook-open-latest.command for OpenClaw jobs or macbook-send-audio-to-openclaw.command for GarageBand-originated audio."
}
JSON

open "${BRIDGE_ROOT}"
if [[ "${OVERALL_STATUS}" == "ready" ]]; then
  osascript -e 'display dialog "GarageBand and Valhalla Supermassive are ready for the OpenClaw bridge." buttons {"OK"} default button "OK"'
else
  open "${BLOCKERS_FILE}"
  osascript -e 'display dialog "Setup is not fully ready yet. The blockers file is open. Fix the listed items, then run macbook-finish-setup.command again." buttons {"OK"} default button "OK"'
fi

echo "MacBook setup status: ${OVERALL_STATUS}"
echo "Status file: ${STATUS_FILE}"
