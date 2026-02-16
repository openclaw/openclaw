#!/usr/bin/env bash
set -euo pipefail

# Generate OPENCLAW_CONFIG_B64 for CVM deployments.
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

# --- Generate full openclaw config JSON ---
CONFIG_JSON=$(node -e "
  const gatewayPort = parseInt(process.argv[5], 10);
  const modelPrimary = process.argv[6];
  const modelBaseUrl = process.argv[7] || '';
  const modelApiKey = process.argv[8] || '';

  const cfg = {
    messages: { ackReactionScope: 'group-mentions' },
    gateway: {
      mode: 'local',
      bind: 'lan',
      port: gatewayPort,
      auth: { mode: 'token', token: process.argv[1] },
      controlUi: { dangerouslyDisableDeviceAuth: true },
      nodes: {
        denyCommands: [
          'camera.snap', 'camera.clip', 'screen.record',
          'calendar.add', 'contacts.add', 'reminders.add',
        ],
      },
      http: {
        endpoints: {
          mux: {
            enabled: true,
            baseUrl: process.argv[2],
            registerKey: process.argv[3],
            inboundUrl: process.argv[4],
          },
        },
      },
    },
    update: { checkOnStart: false },
    channels: {},
    plugins: { entries: {} },
  };

  for (const ch of ['telegram', 'discord', 'whatsapp']) {
    cfg.channels[ch] = {
      accounts: {
        default: { enabled: false },
        mux: { enabled: true, mux: { enabled: true, timeoutMs: 30000 } },
      },
    };
    cfg.plugins.entries[ch] = { enabled: true };
  }

  if (modelBaseUrl && modelApiKey) {
    cfg.models = {
      providers: {
        openai: {
          baseUrl: modelBaseUrl,
          apiKey: modelApiKey,
          models: [],
        },
      },
    };
  }

  cfg.agents = {
    defaults: {
      workspace: '/root/.openclaw/workspace',
      model: { primary: modelPrimary },
      maxConcurrent: 4,
      subagents: { maxConcurrent: 8 },
      compaction: { mode: 'safeguard' },
    },
  };

  process.stdout.write(JSON.stringify(cfg, null, 2));
" "$GATEWAY_AUTH_TOKEN" "$MUX_BASE_URL" "$MUX_REGISTER_KEY" "$INBOUND_URL" "$GATEWAY_PORT" "$MODEL_PRIMARY" "${MODEL_BASE_URL:-}" "${MODEL_API_KEY:-}")

printf '%s' "$CONFIG_JSON" | base64 -w0
