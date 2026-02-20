#!/usr/bin/env bash
# Migrate a running CVM's openclaw.json to the latest config shape.
#
# Downloads openclaw.json from the CVM container, runs each migration
# script locally, and uploads it back only if something changed.
# Each migration checks the config first and skips if already applied.
#
# Usage:
#   rv-exec COMPOSEIO_ADMIN_API -- bash phala-deploy/migrate-openclaw.sh <CVM_ID>
#
# Migrations:
#   composio   — if COMPOSEIO_ADMIN_API is set and config is missing
#                COMPOSIO_MCP_URL, creates a Tool Router session and
#                injects COMPOSIO_MCP_URL + COMPOSIO_API_KEY
set -euo pipefail

log()  { printf '\033[1;34m[migrate]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[migrate] ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[migrate] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

CVM_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) sed -n '2,/^[^#]/{ /^#/s/^# \?//p }' "$0"; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *)  CVM_ID="$1"; shift ;;
  esac
done

[[ -n "$CVM_ID" ]] || die "usage: migrate-openclaw.sh <CVM_ID>"

REMOTE_CFG="/root/.openclaw/openclaw.json"
REMOTE_TMP="/tmp/openclaw.json"
LOCAL_TMP="$(mktemp /tmp/openclaw-migrate-XXXXXX.json)"
trap 'rm -f "$LOCAL_TMP"' EXIT

# ── download openclaw.json ──────────────────────────────────────────────────

log "Downloading openclaw.json from CVM ${CVM_ID}..."
phala ssh "$CVM_ID" -- docker cp "openclaw:${REMOTE_CFG}" "$REMOTE_TMP" \
  || die "docker cp from container failed"
phala cp "${CVM_ID}:${REMOTE_TMP}" "$LOCAL_TMP" \
  || die "phala cp download failed"
ok "Downloaded openclaw.json ($(wc -c < "$LOCAL_TMP") bytes)"

CHECKSUM_BEFORE=$(md5sum "$LOCAL_TMP" | cut -d' ' -f1)

# ── migrations ──────────────────────────────────────────────────────────────
# Each migration is a self-contained node script that:
#   1. Reads the config from process.argv[1]
#   2. Checks if the migration is already applied → exits 0 if so
#   3. Makes any needed API calls
#   4. Patches the config and writes it back
# Secrets are passed via environment variables.

# --- Migration: Composio standalone ---
if [[ -n "${COMPOSEIO_ADMIN_API:-}" ]]; then
  log "Migration: composio..."
  COMPOSIO_API_KEY="${COMPOSEIO_ADMIN_API}" node -e '
    const fs = require("fs");

    async function main() {
      const cfgPath = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const env = cfg.skills?.entries?.composio?.env || {};
      const apiKey = process.env.COMPOSIO_API_KEY;

      if (env.COMPOSIO_MCP_URL && env.COMPOSIO_API_KEY) {
        console.log("  composio: already configured, skipping.");
        return;
      }

      const res = await fetch("https://backend.composio.dev/api/v3/tool_router/session", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "default" }),
      });
      if (!res.ok) throw new Error("API returned " + res.status + ": " + await res.text());
      const r = await res.json();
      const mcpUrl = r?.mcp?.url || r?.session?.mcp?.url || "";
      if (!mcpUrl) throw new Error("no MCP URL in response");

      if (!cfg.skills) cfg.skills = {};
      if (!cfg.skills.entries) cfg.skills.entries = {};
      if (!cfg.skills.entries.composio) cfg.skills.entries.composio = {};
      if (!cfg.skills.entries.composio.env) cfg.skills.entries.composio.env = {};
      cfg.skills.entries.composio.env.COMPOSIO_MCP_URL = mcpUrl;
      cfg.skills.entries.composio.env.COMPOSIO_API_KEY = apiKey;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log("  composio: configured (MCP URL: " + mcpUrl + ")");
    }
    main().catch(e => { console.error("  composio: " + e.message); process.exit(1); });
  ' "$LOCAL_TMP" || die "composio migration failed"
else
  log "Migration: composio — skipped (no COMPOSEIO_ADMIN_API)"
fi

# --- (future migrations go here) ---

# ── upload if changed ───────────────────────────────────────────────────────

CHECKSUM_AFTER=$(md5sum "$LOCAL_TMP" | cut -d' ' -f1)

if [[ "$CHECKSUM_BEFORE" == "$CHECKSUM_AFTER" ]]; then
  ok "No changes — config already up to date."
  exit 0
fi

log "Uploading openclaw.json to CVM..."
phala cp "$LOCAL_TMP" "${CVM_ID}:${REMOTE_TMP}" \
  || die "phala cp upload failed"
phala ssh "$CVM_ID" -- docker cp "${REMOTE_TMP}" "openclaw:${REMOTE_CFG}" \
  || die "docker cp into container failed"

ok "Done — openclaw.json migrated on CVM ${CVM_ID}"
