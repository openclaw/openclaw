#!/usr/bin/env bash
# staging-up.sh — Deploy (or start) the openclaw-jhs-staging Fly.io app.
#
# Usage: ./scripts/staging-up.sh [--skip-workspace-sync]
#
# On a fresh app creation:
#   1. Creates the volume
#   2. Loads all secrets from .fly-secrets
#   3. Deploys the app
#   4. Seeds stable workspace files from scripts/seed-workspace/ (git-controlled)
#   5. Syncs dynamic workspace files from prod (MEMORY.md + business docs)
#
# Pass --skip-workspace-sync to skip steps 4+5 (e.g. for CI deploys where prod
# may not be reachable or you want a blank-slate Larry).

set -euo pipefail

STAGING_APP="openclaw-jhs-staging"
PROD_APP="openclaw-jhs"
STAGING_CONFIG="fly-staging.toml"
SKIP_WORKSPACE_SYNC=false

for arg in "$@"; do
  [[ "$arg" == "--skip-workspace-sync" ]] && SKIP_WORKSPACE_SYNC=true
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_DIR="$SCRIPT_DIR/seed-workspace"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[staging-up]${NC} $*"; }
warn() { echo -e "${YELLOW}[staging-up]${NC} $*"; }
fail() { echo -e "${RED}[staging-up]${NC} $*" >&2; exit 1; }

command -v fly &>/dev/null || fail "'fly' CLI not found. Install from https://fly.io/docs/hands-on/install-flyctl/"

# ── 1. Create app if it doesn't exist ────────────────────────────────────────
APP_IS_NEW=false
if ! fly apps list --json 2>/dev/null | python3 -c "import sys,json; apps=[a['Name'] for a in json.load(sys.stdin)]; exit(0 if '${STAGING_APP}' in apps else 1)" 2>/dev/null; then
  log "App $STAGING_APP not found — creating it..."
  fly apps create "$STAGING_APP" || fail "Failed to create app $STAGING_APP"
  APP_IS_NEW=true
fi

# ── 2. On new app: create volume + load secrets ───────────────────────────────
if [ "$APP_IS_NEW" = true ]; then
  log "New app — creating volume..."
  fly volumes create openclaw_staging_data --app "$STAGING_APP" --region iad --size 1 --yes \
    || fail "Failed to create staging volume"

  SECRETS_FILE="$SCRIPT_DIR/../.fly-secrets"
  if [ -f "$SECRETS_FILE" ]; then
    log "Loading secrets from .fly-secrets..."
    SECRET_ARGS=$(grep -v '^\s*#' "$SECRETS_FILE" | grep -v '^\s*$' | tr '\n' ' ')
    # shellcheck disable=SC2086
    fly secrets set $SECRET_ARGS --app "$STAGING_APP" || warn "Some secrets may not have been set"
  else
    warn ".fly-secrets not found — skipping secret seeding."
  fi
fi

# ── 3. Deploy ─────────────────────────────────────────────────────────────────
log "Deploying $STAGING_APP..."
fly deploy --config "$STAGING_CONFIG" --app "$STAGING_APP" --ha=false || fail "Deploy failed."

# ── 4+5. Workspace sync (new app only, unless --skip-workspace-sync) ──────────
if [ "$APP_IS_NEW" = true ] && [ "$SKIP_WORKSPACE_SYNC" = false ]; then
  log "Seeding agent workspaces on staging..."
  SYNC_TMP="$(mktemp -d)"

  # Helper: seed stable files from a git seed dir into a workspace on staging
  seed_workspace() {
    local workspace="$1" seed_dir="$2"
    fly ssh console --app "$STAGING_APP" -C "mkdir -p /data/$workspace" 2>/dev/null || true
    if [ -d "$seed_dir" ]; then
      for f in "$seed_dir"/*.md; do
        local fname
        fname="$(basename "$f")"
        fly ssh console --app "$STAGING_APP" -C "rm -f /data/$workspace/$fname" 2>/dev/null || true
        fly sftp put --app "$STAGING_APP" "$f" "/data/$workspace/$fname" \
          && log "    Seeded $fname" || warn "    Could not seed $fname"
      done
    else
      warn "    $seed_dir not found — skipping"
    fi
  }

  # Helper: sync a single file from prod to staging
  sync_from_prod() {
    local workspace="$1" fname="$2"
    if fly sftp get --app "$PROD_APP" "/data/$workspace/$fname" "$SYNC_TMP/$fname" 2>/dev/null; then
      fly ssh console --app "$STAGING_APP" -C "rm -f /data/$workspace/$fname" 2>/dev/null || true
      fly sftp put --app "$STAGING_APP" "$SYNC_TMP/$fname" "/data/$workspace/$fname" \
        && log "    Synced $fname from prod" || warn "    Could not upload $fname"
      rm -f "$SYNC_TMP/$fname"
    else
      warn "    $fname not found on prod — skipping"
    fi
  }

  # ── Larry ────────────────────────────────────────────────────────────────
  log "  Agent: workspace-larry"
  seed_workspace "workspace-larry" "$SCRIPT_DIR/seed-workspace"
  sync_from_prod "workspace-larry" "MEMORY.md"
  sync_from_prod "workspace-larry" "EXECUTIVE-SUMMARY.md"
  sync_from_prod "workspace-larry" "OPENCLAW-BUSINESS-STRATEGY-NOTES.md"
  sync_from_prod "workspace-larry" "ROCKY-POINT-README.md"
  sync_from_prod "workspace-larry" "JHS-Digital-Consulting-Accountable-Plan-2026.md"

  # ── Peterino ─────────────────────────────────────────────────────────────
  log "  Agent: workspace-peterino"
  seed_workspace "workspace-peterino" "$SCRIPT_DIR/seed-workspace-peterino"
  sync_from_prod "workspace-peterino" "MEMORY.md"

  # ── Joao ─────────────────────────────────────────────────────────────────
  log "  Agent: workspace-joao"
  seed_workspace "workspace-joao" "$SCRIPT_DIR/seed-workspace-joao"

  rm -rf "$SYNC_TMP"

  # fly sftp uploads files as root — fix ownership so the node process can write
  log "  Fixing workspace file ownership..."
  fly ssh console --app "$STAGING_APP" -C 'chown -R node:node /data/workspace-larry /data/workspace-peterino /data/workspace-joao' 2>/dev/null || true

  log "Workspace sync complete."
fi

log "Staging is up: https://$STAGING_APP.fly.dev/"
fly status --app "$STAGING_APP"
