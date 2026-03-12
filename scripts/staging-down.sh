#!/usr/bin/env bash
# staging-down.sh — Stop all machines in the openclaw-jhs-staging Fly.io app.
#
# Usage: ./scripts/staging-down.sh
#
# Stops (destroys) all machines but preserves the app, volume, and secrets so
# that credential files and workspace data survive across staging cycles.
# The volume costs ~$0.15/month — negligible compared to machine time.
# Run staging-up.sh to redeploy when needed.

set -euo pipefail

STAGING_APP="openclaw-jhs-staging"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[staging-down]${NC} $*"; }
warn() { echo -e "${YELLOW}[staging-down]${NC} $*"; }
fail() { echo -e "${RED}[staging-down]${NC} $*" >&2; exit 1; }

command -v fly &>/dev/null || fail "'fly' CLI not found. Install from https://fly.io/docs/hands-on/install-flyctl/"

# Check if app exists at all
if ! fly apps list --json 2>/dev/null | python3 -c "import sys,json; apps=[a['Name'] for a in json.load(sys.stdin)]; exit(0 if '${STAGING_APP}' in apps else 1)" 2>/dev/null; then
  warn "App $STAGING_APP does not exist — nothing to stop."
  exit 0
fi

# Stop all running machines (volume and secrets are preserved)
MACHINES=$(fly machine list --app "$STAGING_APP" --json 2>/dev/null || echo "[]")
IDS=$(echo "$MACHINES" | python3 -c "import sys,json; print('\n'.join(m['id'] for m in json.load(sys.stdin)))" 2>/dev/null || echo "")
if [ -n "$IDS" ]; then
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    log "  Stopping machine $id..."
    fly machine stop "$id" --app "$STAGING_APP" 2>/dev/null || warn "Could not stop $id (may already be stopped)"
  done <<< "$IDS"
else
  warn "No machines found — already down."
fi

log "Done — all machines stopped. Volume and secrets preserved."
log "Run ./scripts/staging-up.sh to redeploy."
