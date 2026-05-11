#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGED_APP="$ROOT_DIR/dist/OpenClaw.app"
INSTALLED_APP="${OPENCLAW_APP_BUNDLE:-/Applications/OpenClaw.app}"
APP_PROCESS_PATTERN="OpenClaw.app/Contents/MacOS/OpenClaw"

usage() {
  echo "usage: $0 [run|--verify|--logs|--telemetry]" >&2
}

case "$MODE" in
  run|--verify|verify|--logs|logs|--telemetry|telemetry) ;;
  *)
    usage
    exit 2
    ;;
esac

pkill -f "$APP_PROCESS_PATTERN" >/dev/null 2>&1 || true
pkill -x OpenClaw >/dev/null 2>&1 || true

cd "$ROOT_DIR"
pnpm canvas:a2ui:bundle
SIGN_IDENTITY_VALUE="${OPENCLAW_SIGN_IDENTITY:-}"
if [[ -z "$SIGN_IDENTITY_VALUE" ]]; then
  SIGN_IDENTITY_VALUE="$(security find-identity -p codesigning -v 2>/dev/null | awk '/Apple Development|Developer ID Application|Apple Distribution/ {identity=$2} END {print identity}')"
fi
if [[ -z "$SIGN_IDENTITY_VALUE" ]]; then
  SIGN_IDENTITY_VALUE="-"
  export ALLOW_ADHOC_SIGNING=1
else
  unset ALLOW_ADHOC_SIGNING
fi
SKIP_PNPM_INSTALL="${SKIP_PNPM_INSTALL:-1}" \
SKIP_TSC="${SKIP_TSC:-1}" \
SIGN_IDENTITY="$SIGN_IDENTITY_VALUE" \
scripts/package-mac-app.sh

if [[ ! -d "$STAGED_APP" ]]; then
  echo "packaged app missing: $STAGED_APP" >&2
  exit 1
fi

rm -rf "$INSTALLED_APP"
ditto "$STAGED_APP" "$INSTALLED_APP"
rm -rf "$STAGED_APP"

open_app() {
  /usr/bin/open "$INSTALLED_APP" --args --attach-only
}

case "$MODE" in
  run)
    open_app
    ;;
  --verify|verify)
    open_app
    sleep 1.5
    pgrep -f "$APP_PROCESS_PATTERN" >/dev/null
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate 'process == "OpenClaw"'
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate 'subsystem BEGINSWITH "ai.openclaw"'
    ;;
esac
