#!/usr/bin/env bash
# staging-up.sh — Deploy (or start) the openclaw-jhs-staging Fly.io app.
#
# Usage: ./scripts/staging-up.sh [--skip-workspace-sync]
#
# Steps:
#   1. Creates the app + volume if needed
#   2. Loads secrets from .fly-secrets (new apps only)
#   3. Deploys the app
#   4. Syncs agent workspaces from production (identity, memory, business docs)
#   5. Copies production config (openclaw.json) to staging
#
# This ensures staging agents have the same identity and memories as production,
# so you can test upgrades without agents losing who they are.
#
# Pass --skip-workspace-sync to skip steps 4+5 (e.g. for CI deploys where prod
# may not be reachable or you want a blank-slate agent).

set -euo pipefail

STAGING_APP="openclaw-jhs-staging"
PROD_APP="openclaw-jhs"
STAGING_CONFIG="fly-staging.toml"
SKIP_WORKSPACE_SYNC=false

for arg in "$@"; do
  [[ "$arg" == "--skip-workspace-sync" ]] && SKIP_WORKSPACE_SYNC=true
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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

# ── 4. Sync openclaw.json from production ────────────────────────────────────
# Agent workspaces are now managed by git (jhs129/openclaw-agents) and restored
# automatically by fly-entrypoint.sh on every boot — no manual tar sync needed.
# We only need to patch openclaw.json with staging-specific overrides.
if [ "$SKIP_WORKSPACE_SYNC" = false ]; then
  log "Syncing openclaw.json from production (with staging overrides)..."
  SYNC_TMP="$(mktemp -d)"

  # Ensure machine is running — fly sftp requires a started machine
  log "  Ensuring staging machine is running..."
  fly machine start --app "$STAGING_APP" 2>/dev/null || true
  fly machine wait --app "$STAGING_APP" --state started 2>/dev/null || true

  PROD_CONFIG="$SYNC_TMP/prod-openclaw.json"
  if fly sftp get --app "$PROD_APP" "/data/openclaw.json" "$PROD_CONFIG" 2>/dev/null; then
    python3 -c "
import json, sys
with open('$PROD_CONFIG') as f: prod = json.load(f)
prod.setdefault('gateway', {}).setdefault('controlUi', {})['dangerouslyAllowHostHeaderOriginFallback'] = True
prod['gateway']['controlUi']['dangerouslyDisableDeviceAuth'] = True
json.dump(prod, sys.stdout, indent=2)
" > "$SYNC_TMP/patched-openclaw.json" 2>/dev/null
    fly ssh console --app "$STAGING_APP" -C "sh -c 'rm -f /data/openclaw.json'" 2>/dev/null || true
    fly sftp put --app "$STAGING_APP" "$SYNC_TMP/patched-openclaw.json" "/data/openclaw.json" \
      && log "  Config synced (prod config + staging overrides)" \
      || warn "  Could not upload config"
  else
    warn "  Could not download prod config — staging will use bootstrap config"
  fi

  rm -rf "$SYNC_TMP"

  # ── Sync persistent data files from prod ──────────────────────────────────
  # These live on prod's volume and are not in git: OAuth tokens, API credentials,
  # Google Workspace config, and gh CLI auth. Without them, agent tool checks fail.
  log "Syncing data files from production..."
  SYNC_DATA_TMP="$(mktemp -d)"

  # Token/credential JSON files (exclude openclaw.json and qbo-* which are large/dynamic)
  for f in m365-tokens.json ownerrez-oauth-credentials.json quickbooks-tokens.json \
            quickbooks-tokens-2.json quickbooks-tokens-3.json stripe-credentials.json; do
    if fly sftp get --app "$PROD_APP" "/data/$f" "$SYNC_DATA_TMP/$f" 2>/dev/null; then
      fly ssh console --app "$STAGING_APP" -C "rm -f /data/$f" 2>/dev/null || true
      fly sftp put --app "$STAGING_APP" "$SYNC_DATA_TMP/$f" "/data/$f" 2>/dev/null \
        && log "  Synced /data/$f" \
        || warn "  Could not upload /data/$f"
    else
      warn "  /data/$f not found on prod — skipping"
    fi
  done

  # Google Workspace CLI config (OAuth client credentials)
  fly ssh console --app "$STAGING_APP" -C "mkdir -p /data/gws-config" 2>/dev/null || true
  for f in credentials.json credentials-chameleon.json credentials-radicaldesign.json client_secret.json; do
    if fly sftp get --app "$PROD_APP" "/data/gws-config/$f" "$SYNC_DATA_TMP/gws-$f" 2>/dev/null; then
      fly ssh console --app "$STAGING_APP" -C "rm -f /data/gws-config/$f" 2>/dev/null || true
      fly sftp put --app "$STAGING_APP" "$SYNC_DATA_TMP/gws-$f" "/data/gws-config/$f" 2>/dev/null \
        && log "  Synced /data/gws-config/$f" \
        || warn "  Could not upload /data/gws-config/$f"
    else
      warn "  /data/gws-config/$f not found on prod — skipping"
    fi
  done

  # gh CLI auth (so 'gh' commands work without re-authenticating)
  fly ssh console --app "$STAGING_APP" -C "mkdir -p /data/config/gh" 2>/dev/null || true
  if fly sftp get --app "$PROD_APP" "/data/config/gh/hosts.yml" "$SYNC_DATA_TMP/gh-hosts.yml" 2>/dev/null; then
    fly ssh console --app "$STAGING_APP" -C "rm -f /data/config/gh/hosts.yml" 2>/dev/null || true
    fly sftp put --app "$STAGING_APP" "$SYNC_DATA_TMP/gh-hosts.yml" "/data/config/gh/hosts.yml" 2>/dev/null \
      && log "  Synced /data/config/gh/hosts.yml" \
      || warn "  Could not upload gh hosts.yml"
  else
    warn "  /data/config/gh/hosts.yml not found on prod — skipping"
  fi

  rm -rf "$SYNC_DATA_TMP"

  # Restart so the gateway picks up the patched config and agents reload from git workspaces.
  log "Restarting gateway..."
  fly machine restart --app "$STAGING_APP" 2>/dev/null || true
  log "Staging is up: https://$STAGING_APP.fly.dev/"
fi

log "Staging is up: https://$STAGING_APP.fly.dev/"
fly status --app "$STAGING_APP"
