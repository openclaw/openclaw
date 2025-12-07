#!/usr/bin/env bash
# Reset Clawdis like Trimmy: kill running instances, rebuild, repackage, relaunch, verify.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${ROOT_DIR}/dist/Clawdis.app"
APP_PROCESS_PATTERN="Clawdis.app/Contents/MacOS/Clawdis"
DEBUG_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/debug/Clawdis"
LOCAL_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build-local/debug/Clawdis"
RELEASE_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/release/Clawdis"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/com.steipete.clawdis.plist"

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

run_step() {
  local label="$1"; shift
  log "==> ${label}"
  if ! "$@"; then
    fail "${label} failed"
  fi
}

write_launch_agent() {
  cat > "${LAUNCH_AGENT}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.steipete.clawdis</string>
  <key>ProgramArguments</key>
  <array>
    <string>${APP_BUNDLE}/Contents/MacOS/Clawdis</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>MachServices</key>
  <dict>
    <key>com.steipete.clawdis.xpc</key>
    <true/>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/clawdis.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/clawdis.log</string>
</dict>
</plist>
PLIST
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

# 4) Install launch agent with Mach service and bootstrap it.
write_launch_agent
launchctl bootout gui/"$UID"/com.steipete.clawdis 2>/dev/null || true
run_step "bootstrap launch agent" launchctl bootstrap gui/"$UID" "${LAUNCH_AGENT}"
run_step "kickstart" launchctl kickstart -k gui/"$UID"/com.steipete.clawdis

# 5) Verify the packaged app is alive.
sleep 1
if pgrep -f "${APP_PROCESS_PATTERN}" >/dev/null 2>&1; then
  log "OK: Clawdis is running (launchd)."
else
  fail "App exited immediately. Check /tmp/clawdis.log or Console.app (User Reports)."
fi
