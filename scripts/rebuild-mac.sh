#!/usr/bin/env bash
# Clean rebuild: kill everything → clean dist → full build → package → install → launch.
# Usage: scripts/rebuild-mac.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log()  { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# 1) Kill OpenClaw app + gateway + signal-cli
log "Killing OpenClaw and signal-cli"
osascript -e 'tell application "OpenClaw" to quit' 2>/dev/null || true
sleep 2
pkill -9 -f "OpenClaw.app/Contents/MacOS/OpenClaw" 2>/dev/null || true
pkill -x "OpenClaw" 2>/dev/null || true
pkill -9 -f "openclaw-gateway" 2>/dev/null || true
pkill -9 -f "signal-cli" 2>/dev/null || true
sleep 1
log "All processes killed"

# 2) Clean dist and installed app
log "Cleaning dist/ and /Applications/OpenClaw.app"
rm -rf dist/OpenClaw.app
rm -rf /Applications/OpenClaw.app

# 3) Full TypeScript build
log "Running pnpm build"
if ! pnpm build; then
  fail "pnpm build failed"
fi
log "Build succeeded"

# 4) Package Mac app (ad-hoc signing for dev)
log "Packaging Mac app"
export ALLOW_ADHOC_SIGNING=1
if ! scripts/package-mac-app.sh; then
  fail "package-mac-app.sh failed"
fi
log "Package succeeded: dist/OpenClaw.app"

# 5) Install to /Applications
log "Installing to /Applications"
cp -R dist/OpenClaw.app /Applications/OpenClaw.app
log "Installed"

# 6) Launch
log "Launching OpenClaw"
open /Applications/OpenClaw.app

# 7) Verify
sleep 3
if pgrep -f "OpenClaw.app/Contents/MacOS/OpenClaw" >/dev/null 2>&1; then
  log "OpenClaw is running ✓"
else
  fail "OpenClaw failed to start — check Console.app"
fi

# Show gateway status
sleep 5
if launchctl print gui/"$UID" 2>/dev/null | grep -q "ai.openclaw.gateway"; then
  log "Gateway service is loaded ✓"
else
  log "Warning: gateway service not yet loaded (may take a few seconds)"
fi
