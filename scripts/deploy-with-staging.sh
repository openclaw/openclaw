#!/usr/bin/env bash
# deploy-with-staging.sh — Deploy to staging first, then production if healthy.
#
# Usage:
#   ./scripts/deploy-with-staging.sh          # staging + production
#   ./scripts/deploy-with-staging.sh --staging-only  # staging only (for testing)
#
# Flow:
#   1. Deploy to openclaw-jhs-staging (no persistent volume, smaller VM)
#   2. Wait for HTTP health check (gateway responds on /)
#   3. If healthy → deploy to openclaw-jhs (production)
#   4. If unhealthy → abort, production untouched

set -euo pipefail

STAGING_APP="openclaw-jhs-staging"
PROD_APP="openclaw-jhs"
STAGING_CONFIG="fly-staging.toml"
MAX_WAIT=180  # seconds to wait for staging to become healthy
CHECK_INTERVAL=5

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
fail() { echo -e "${RED}[deploy]${NC} $*"; exit 1; }

STAGING_ONLY=false
if [[ "${1:-}" == "--staging-only" ]]; then
  STAGING_ONLY=true
fi

# ── Step 1: Deploy to staging ──────────────────────────────────────────────
log "Deploying to staging ($STAGING_APP)..."
fly deploy --config "$STAGING_CONFIG" --app "$STAGING_APP" || fail "Staging deploy failed!"

# ── Step 2: Wait for health ────────────────────────────────────────────────
log "Waiting for staging to become healthy (max ${MAX_WAIT}s)..."
STAGING_URL="https://$STAGING_APP.fly.dev/"
elapsed=0

while [ $elapsed -lt $MAX_WAIT ]; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$STAGING_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "426" ]; then
    log "Staging is healthy! (HTTP $HTTP_CODE after ${elapsed}s)"
    break
  fi

  echo -n "."
  sleep $CHECK_INTERVAL
  elapsed=$((elapsed + CHECK_INTERVAL))
done

if [ $elapsed -ge $MAX_WAIT ]; then
  fail "Staging failed to become healthy after ${MAX_WAIT}s. Aborting — production is untouched."
fi

# ── Step 3: Stop staging to save cost ──────────────────────────────────────
log "Stopping staging machine to save cost..."
fly machine stop --app "$STAGING_APP" --select 2>/dev/null || true

if [ "$STAGING_ONLY" = true ]; then
  log "Staging-only mode — skipping production deploy."
  exit 0
fi

# ── Step 4: Deploy to production ───────────────────────────────────────────
log "Staging passed! Deploying to production ($PROD_APP)..."
fly deploy --app "$PROD_APP" || fail "Production deploy failed!"

log "Production deploy complete! https://$PROD_APP.fly.dev/"
