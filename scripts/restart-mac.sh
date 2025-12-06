#!/usr/bin/env bash
# Reset Clawdis like Trimmy: kill running instances, rebuild, repackage, relaunch, verify.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${ROOT_DIR}/dist/Clawdis.app"
APP_PROCESS_PATTERN="Clawdis.app/Contents/MacOS/Clawdis"
DEBUG_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/debug/Clawdis"
LOCAL_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build-local/debug/Clawdis"
RELEASE_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/release/Clawdis"

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

run_step() {
  local label="$1"; shift
  log "==> ${label}"
  if ! "$@"; then
    fail "${label} failed"
  fi
}

kill_all_clawdis() {
  for _ in {1..10}; do
    pkill -f "${APP_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -f "${DEBUG_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -f "${LOCAL_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -f "${RELEASE_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -x "Clawdis" 2>/dev/null || true
    if ! pgrep -f "${APP_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -f "${DEBUG_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -f "${LOCAL_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -f "${RELEASE_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -x "Clawdis" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.3
  done
}

# 1) Kill all running instances first.
log "==> Killing existing Clawdis instances"
kill_all_clawdis

# 2) Rebuild into the same path the packager consumes (.build).
run_step "clean build cache" bash -lc "cd '${ROOT_DIR}/apps/macos' && rm -rf .build .build-swift .swiftpm"
run_step "swift build" bash -lc "cd '${ROOT_DIR}/apps/macos' && swift build -q --product Clawdis"

# 3) Package + relaunch the app (script also stops any stragglers).
run_step "package app" "${ROOT_DIR}/scripts/package-mac-app.sh"

# 4) Verify the packaged app is alive.
sleep 1
if pgrep -f "${APP_PROCESS_PATTERN}" >/dev/null 2>&1; then
  log "OK: Clawdis is running."
else
  fail "App exited immediately. Check /tmp/clawdis.log or Console.app (User Reports)."
fi
