#!/usr/bin/env bash
set -euo pipefail

# Generate OPENCLAW_CONFIG_B64 for CVM deployments.
#
# Reads openclaw.template.json for static config, then merges in dynamic
# values (secrets, URLs, model config) derived from environment variables.
#
# Required env vars:
#   MASTER_KEY        — derives gateway auth token via HKDF-SHA256
#   MUX_BASE_URL      — external mux-server URL (e.g. https://<hash>-18891.dstack-prod.phala.network)
#   MUX_REGISTER_KEY  — shared key for mux registration
#
# Optional env vars:
#   MODEL_BASE_URL    — AI provider base URL (omitted from config if unset)
#   MODEL_API_KEY     — AI provider API key (omitted from config if unset)
#
# Output: prints OPENCLAW_CONFIG_B64 to stdout (base64, no line wrapping).

: "${MASTER_KEY:?MASTER_KEY is required}"
: "${MUX_BASE_URL:?MUX_BASE_URL is required}"
: "${MUX_REGISTER_KEY:?MUX_REGISTER_KEY is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/openclaw.template.json"
[[ -f "$TEMPLATE" ]] || { echo "ERROR: template not found: $TEMPLATE" >&2; exit 1; }

GATEWAY_PORT=18789
MODEL_PRIMARY="openai/gpt-5.3-codex"

# --- Derive GATEWAY_AUTH_TOKEN from MASTER_KEY (same HKDF as entrypoint.sh) ---
GATEWAY_AUTH_TOKEN=$(node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', process.argv[1], '', 'gateway-auth-token', 32);
  process.stdout.write(Buffer.from(key).toString('base64'));
" "$MASTER_KEY" | tr -d '/+=' | head -c 32)

# inboundUrl uses ${DSTACK_APP_ID} / ${DSTACK_GATEWAY_DOMAIN} placeholders —
# resolved by the config loader's env-substitution (vars forwarded via docker-compose.yml)
INBOUND_URL="https://\${DSTACK_APP_ID}-${GATEWAY_PORT}.\${DSTACK_GATEWAY_DOMAIN}/v1/mux/inbound"

# --- Merge dynamic values into template ---
CONFIG_JSON=$(node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));

  // Gateway auth + mux endpoint (dynamic/secret)
  cfg.gateway.auth = { mode: 'token', token: process.argv[2] };
  cfg.gateway.http = {
    endpoints: {
      mux: {
        enabled: true,
        baseUrl: process.argv[3],
        registerKey: process.argv[4],
        inboundUrl: process.argv[5],
      },
    },
  };

  // Model config (dynamic, primary always set; provider only if URL+key given)
  cfg.agents.defaults.model = { primary: process.argv[6] };
  const modelBaseUrl = process.argv[7] || '';
  const modelApiKey = process.argv[8] || '';
  if (modelBaseUrl && modelApiKey) {
    cfg.models = {
      providers: {
        openai: { baseUrl: modelBaseUrl, apiKey: modelApiKey, models: [] },
      },
    };
  }

  process.stdout.write(JSON.stringify(cfg, null, 2));
" "$TEMPLATE" "$GATEWAY_AUTH_TOKEN" "$MUX_BASE_URL" "$MUX_REGISTER_KEY" "$INBOUND_URL" "$MODEL_PRIMARY" "${MODEL_BASE_URL:-}" "${MODEL_API_KEY:-}")

printf '%s' "$CONFIG_JSON" | base64 -w0
