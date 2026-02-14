#!/usr/bin/env bash
#
# update-and-restart.sh — Rebase, build, link, push, and restart OpenClaw gateway
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
  echo ""
  git status --short
  echo ""
  fail "Working tree is dirty — commit or stash your changes first."
fi

# --- Record pre-pull state ---
OLD_SHORT=$(git rev-parse --short HEAD)
log "Current commit: ${OLD_SHORT}"

# --- Rebase adabot on top of origin/main ---
# This repo is the single source of truth for adabot.
# We rebase our commits on top of upstream (origin/main), then force-push out.
# Never pull/rebase from bitbucket/fork — those are downstream mirrors.
log "Fetching origin..."
UPSTREAM_BEFORE=$(git rev-parse origin/main)
git fetch origin 2>&1 || fail "Could not fetch origin"
UPSTREAM_AFTER=$(git rev-parse origin/main)
log "Rebasing onto origin/main..."
if git rebase origin/main 2>&1; then
  ok "Rebase onto origin/main complete"
else
  warn "Rebase failed — aborting rebase and stopping."
  git rebase --abort 2>/dev/null || true
  fail "Rebase onto origin/main failed (conflicts?). Resolve manually."
fi

BUILT_SHA=$(git rev-parse HEAD)
BUILT_SHORT=$(git rev-parse --short HEAD)

if [ "$UPSTREAM_BEFORE" = "$UPSTREAM_AFTER" ]; then
  log "Already up to date with origin/main (${BUILT_SHORT})"
else
  log "Rebased onto new upstream commits (${BUILT_SHORT})"
  echo ""
  UPSTREAM_COUNT=$(git rev-list --count "${UPSTREAM_BEFORE}..${UPSTREAM_AFTER}")
  if [ "$UPSTREAM_COUNT" -gt 20 ]; then
    log "(showing last 20 of ${UPSTREAM_COUNT} new upstream commits)"
  fi
  git --no-pager log --oneline -20 "${UPSTREAM_BEFORE}..${UPSTREAM_AFTER}"
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
pnpm format:check 2>&1 || fail "Format check failed — run 'pnpm exec oxfmt --write <file>' to fix"
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

log "Built commit: ${BUILT_SHORT} (${BUILT_SHA})"

# --- Force-push to remotes (this repo is source of truth) ---
BRANCH=$(git branch --show-current)
log "Force-pushing ${BRANCH} to bitbucket and fork..."
BB_OK=0; FK_OK=0
git push --force-with-lease bitbucket "HEAD:${BRANCH}" 2>&1 && BB_OK=1 || warn "Could not push to bitbucket"
git push --force-with-lease fork "HEAD:${BRANCH}" 2>&1 && FK_OK=1 || warn "Could not push to fork"
if [ "$BB_OK" -eq 1 ] && [ "$FK_OK" -eq 1 ]; then
  ok "Pushed to both remotes"
elif [ "$BB_OK" -eq 1 ] || [ "$FK_OK" -eq 1 ]; then
  warn "Pushed to one remote only (see warnings above)"
else
  fail "Could not push to either remote"
fi

# --- Restart gateway ---
log "Restarting gateway..."
openclaw gateway restart 2>&1 || fail "Gateway restart failed"

# --- Wait for gateway to come back and verify ---
log "Waiting for gateway health..."
HEALTHY=0
for i in {1..10}; do
  if openclaw gateway health 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [ "$HEALTHY" -eq 1 ]; then
  ok "Gateway is healthy"
else
  warn "Gateway health check failed after 10 attempts — may need manual inspection"
fi

# --- Summary ---
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  OpenClaw updated and restarted!${NC}"
echo -e "${GREEN}  Commit: ${BUILT_SHORT}${NC}"
if [ "$UPSTREAM_BEFORE" != "$UPSTREAM_AFTER" ]; then
  echo -e "${GREEN}  Upstream: ${UPSTREAM_COUNT} new commit(s) from origin/main${NC}"
fi
echo -e "${GREEN}════════════════════════════════════════${NC}"
