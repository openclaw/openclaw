#!/usr/bin/env bash
set -euo pipefail

DEVICE_UDID="${1:-00008130-000630CE0146001C}"
BUNDLE_ID="${2:-ai.activi.ios.dev.mariano.test}"
DEST="${3:-/tmp/activi-gateway.log}"

xcrun devicectl device copy from \
  --device "$DEVICE_UDID" \
  --domain-type appDataContainer \
  --domain-identifier "$BUNDLE_ID" \
  --source Documents/activi-gateway.log \
  --destination "$DEST" >/dev/null

echo "Pulled to: $DEST"
tail -n 200 "$DEST"

