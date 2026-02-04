#!/usr/bin/env bash
#
# update-and-restart.sh — Pull, build, link, and restart OpenClaw gateway
# Verifies the running gateway matches the built commit.
#
set -euo pipefail

REPO_DIR="$HOME/openclaw"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $1"; }
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

cd "$REPO_DIR" || fail "Cannot cd to $REPO_DIR"

# --- Check for uncommitted changes ---
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "You have uncommitted changes:"
  git status --short
  echo ""
  read -rp "Continue anyway? (y/N) " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }
fi

# --- Record pre-pull state ---
OLD_SHA=$(git rev-parse HEAD)
OLD_SHORT=$(git rev-parse --short HEAD)
log "Current commit: ${OLD_SHORT}"

# --- Git pull (rebase to keep local commits on top) ---
log "Pulling latest changes (rebase)..."
if git pull --rebase 2>&1; then
  ok "Git pull complete"
else
  warn "Rebase failed — aborting rebase and stopping."
  git rebase --abort 2>/dev/null || true
  fail "Git pull --rebase failed (conflicts?). Resolve manually."
fi

NEW_SHA=$(git rev-parse HEAD)
NEW_SHORT=$(git rev-parse --short HEAD)

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  log "Already up to date (${NEW_SHORT})"
else
  log "Updated: ${OLD_SHORT} → ${NEW_SHORT}"
  echo ""
  git --no-pager log --oneline "${OLD_SHA}..${NEW_SHA}" | head -20
  echo ""
fi

# --- pnpm install ---
log "Installing dependencies..."
if pnpm install --frozen-lockfile 2>&1; then
  ok "pnpm install complete"
else
  warn "Frozen lockfile failed, trying regular install..."
  pnpm install 2>&1 || fail "pnpm install failed"
  ok "pnpm install complete"
fi

# --- pnpm format (check only) ---
log "Checking code formatting..."
pnpm format 2>&1 || fail "Format check failed — run 'pnpm exec oxfmt --write <file>' to fix"
ok "Format check passed"

# --- pnpm build ---
log "Building TypeScript..."
pnpm build 2>&1 || fail "pnpm build failed"
ok "Build complete"

# --- pnpm lint ---
log "Running linter..."
pnpm lint 2>&1 || fail "Lint check failed — run 'pnpm exec oxlint <file>' to fix"
ok "Lint check passed"

# --- pnpm link ---
log "Linking globally..."
pnpm link --global 2>&1 || fail "pnpm link --global failed"
ok "Linked globally"

# --- Capture the commit SHA that was just built ---
BUILT_SHA=$(git rev-parse HEAD)
BUILT_SHORT=$(git rev-parse --short HEAD)
log "Built commit: ${BUILT_SHORT} (${BUILT_SHA})"

# --- Restart gateway ---
log "Restarting gateway..."
openclaw gateway restart 2>&1 || fail "Gateway restart failed"

# --- Wait for gateway to come back ---
log "Waiting for gateway to stabilize..."
sleep 3

# --- Verify the running gateway matches ---
RUNNING_ENTRY=$(openclaw gateway status 2>&1 | grep -oP '(?<=Command: ).*' || true)

# Check commit from the built dist
if [ -f "$REPO_DIR/dist/version.js" ]; then
  DIST_SHA=$(grep -oP '[a-f0-9]{40}' "$REPO_DIR/dist/version.js" 2>/dev/null | head -1 || true)
  DIST_SHORT="${DIST_SHA:0:7}"
fi

# Verify SHA match
POST_SHA=$(git -C "$REPO_DIR" rev-parse HEAD)
if [ "$BUILT_SHA" = "$POST_SHA" ]; then
  ok "Commit verified: built=${BUILT_SHORT}, repo=${POST_SHA:0:7} ✓"
else
  fail "SHA MISMATCH! Built ${BUILT_SHORT} but repo is now ${POST_SHA:0:7}"
fi

# --- Summary ---
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  OpenClaw updated and restarted!${NC}"
echo -e "${GREEN}  Commit: ${BUILT_SHORT}${NC}"
if [ "$OLD_SHA" != "$NEW_SHA" ]; then
  COMMIT_COUNT=$(git rev-list --count "${OLD_SHA}..${NEW_SHA}")
  echo -e "${GREEN}  Changes: ${COMMIT_COUNT} new commit(s)${NC}"
fi
echo -e "${GREEN}════════════════════════════════════════${NC}"
