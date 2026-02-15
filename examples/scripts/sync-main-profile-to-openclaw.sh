#!/usr/bin/env bash
set -euo pipefail

SOURCE_PROFILE_DIR="${SOURCE_PROFILE_DIR:-$HOME/.config/google-chrome}"
TARGET_PROFILE_DIR="${TARGET_PROFILE_DIR:-$HOME/chrome-profiles/main-openclaw}"
CHROME_SERVICE="${CHROME_SERVICE:-openclaw-chrome-main.service}"

if [[ ! -d "${SOURCE_PROFILE_DIR}" ]]; then
  echo "Source profile not found: ${SOURCE_PROFILE_DIR}" >&2
  exit 1
fi

mkdir -p "${TARGET_PROFILE_DIR}"

if [[ -S "/run/user/$(id -u)/bus" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  systemctl --user stop "${CHROME_SERVICE}" >/dev/null 2>&1 || true
fi

rsync -a --delete \
  --exclude='Singleton*' \
  --exclude='*.lock' \
  --exclude='DevToolsActivePort' \
  --exclude='BrowserMetrics*' \
  --exclude='CrashpadMetrics*' \
  --exclude='Safe Browsing' \
  --exclude='component_crx_cache' \
  --exclude='GrShaderCache' \
  --exclude='ShaderCache' \
  "${SOURCE_PROFILE_DIR}/" "${TARGET_PROFILE_DIR}/"

if [[ -S "/run/user/$(id -u)/bus" ]]; then
  systemctl --user start "${CHROME_SERVICE}" >/dev/null 2>&1 || true
fi

echo "Profile sync complete: ${SOURCE_PROFILE_DIR} -> ${TARGET_PROFILE_DIR}"
