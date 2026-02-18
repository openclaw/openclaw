#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"
MUX_BASE_INTERNAL="http://mux-server:18891"
OPENCLAW_INBOUND_INTERNAL="http://openclaw:18789/v1/mux/inbound"
: "${MUX_REGISTER_KEY:=local-mux-e2e-register-key}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[local-mux-e2e] docker is required." >&2
  exit 1
fi

if ! command -v rv-exec >/dev/null 2>&1; then
  echo "[local-mux-e2e] rv-exec is required for secret injection." >&2
  exit 1
fi

# Optional local overrides for non-secret values.
if [[ -f "${STACK_DIR}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${STACK_DIR}/.env.local"
  set +a
fi

"${SCRIPT_DIR}/prepare-whatsapp-auth.sh"

# --- Derive GATEWAY_AUTH_TOKEN from MASTER_KEY (same HKDF as entrypoint.sh) ---
: "${MASTER_KEY:=local-mux-e2e-master-key}"

GATEWAY_AUTH_TOKEN=$(node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', process.argv[1], '', 'gateway-auth-token', 32);
  process.stdout.write(Buffer.from(key).toString('base64'));
" "$MASTER_KEY" | tr -d '/+=' | head -c 32)

# --- Generate full openclaw config JSON ---
CONFIG_JSON=$(node -e "
  const cfg = {
    gateway: {
      mode: 'local',
      bind: 'lan',
      port: 18789,
      auth: { token: process.argv[1] },
      controlUi: { enabled: false },
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
  process.stdout.write(JSON.stringify(cfg, null, 2));
" "$GATEWAY_AUTH_TOKEN" "$MUX_BASE_INTERNAL" "$MUX_REGISTER_KEY" "$OPENCLAW_INBOUND_INTERNAL")

OPENCLAW_CONFIG_B64=$(printf '%s' "$CONFIG_JSON" | base64 -w0)
export OPENCLAW_CONFIG_B64

# --- Bring up the stack ---
rv-exec TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN \
  -- docker compose -f "${COMPOSE_FILE}" up -d --build --remove-orphans

# --- Wait for gateway health ---
echo "[local-mux-e2e] waiting for gateway health..."
for i in $(seq 1 120); do
  if curl -so /dev/null http://127.0.0.1:18789/v1/mux/inbound 2>/dev/null; then
    break
  fi
  sleep 2
done

echo "[local-mux-e2e] stack is up"
echo "[local-mux-e2e] generate pairing token with: ${SCRIPT_DIR}/pair-token.sh telegram"
