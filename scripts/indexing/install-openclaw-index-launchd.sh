#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LABEL="ai.openclaw.index-refresh"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
RUNNER="${SCRIPT_DIR}/run-openclaw-index-refresh.sh"

mkdir -p "${PLIST_DIR}"

cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${RUNNER}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${REPO_ROOT}/.openclaw-index/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>${REPO_ROOT}/.openclaw-index/logs/launchd.err.log</string>
  </dict>
</plist>
PLIST

mkdir -p "${REPO_ROOT}/.openclaw-index/logs"

if launchctl list | grep -q "${LABEL}"; then
  launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
fi

launchctl load "${PLIST_PATH}"

echo "Installed launchd job: ${LABEL}"
echo "Plist: ${PLIST_PATH}"
echo "Runner: ${RUNNER}"
echo "Status: launchctl list | grep ${LABEL}"
