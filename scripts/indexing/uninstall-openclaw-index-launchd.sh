#!/usr/bin/env bash
set -euo pipefail

LABEL="ai.openclaw.index-refresh"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if launchctl list | grep -q "${LABEL}"; then
  launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
fi

rm -f "${PLIST_PATH}"

echo "Uninstalled launchd job: ${LABEL}"
