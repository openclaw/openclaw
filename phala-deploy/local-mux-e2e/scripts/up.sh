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

rv-exec TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN \
  -- docker compose -f "${COMPOSE_FILE}" up -d --build --remove-orphans

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

echo "[local-mux-e2e] waiting for openclaw container..."
for i in $(seq 1 60); do
  if compose exec -T openclaw true >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "${i}" == "60" ]]; then
    echo "[local-mux-e2e] openclaw container not ready after 60s" >&2
    exit 1
  fi
done

echo "[local-mux-e2e] waiting for openclaw config file..."
for i in $(seq 1 60); do
  if compose exec -T openclaw bash -lc 'test -f /root/.openclaw/openclaw.json' >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "${i}" == "60" ]]; then
    echo "[local-mux-e2e] /root/.openclaw/openclaw.json not ready after 60s" >&2
    exit 1
  fi
done

echo "[local-mux-e2e] configuring openclaw mux endpoint..."
compose exec -T openclaw node - "${MUX_REGISTER_KEY}" "${MUX_BASE_INTERNAL}" "${OPENCLAW_INBOUND_INTERNAL}" <<'NODE'
const fs = require("fs");
const path = "/root/.openclaw/openclaw.json";
const registerKey = process.argv[2];
const muxBaseUrl = process.argv[3];
const inboundUrl = process.argv[4];

if (!registerKey || !muxBaseUrl || !inboundUrl) {
  throw new Error("registerKey, muxBaseUrl, and inboundUrl are required");
}

const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
cfg.gateway = cfg.gateway || {};
cfg.gateway.http = cfg.gateway.http || {};
cfg.gateway.http.endpoints = cfg.gateway.http.endpoints || {};
cfg.gateway.http.endpoints.mux = {
  enabled: true,
  baseUrl: muxBaseUrl,
  registerKey,
  inboundUrl,
};

cfg.channels = cfg.channels || {};
for (const channel of ["telegram", "discord", "whatsapp"]) {
  const channelCfg = (cfg.channels[channel] = cfg.channels[channel] || {});
  if ("enabled" in channelCfg) {
    delete channelCfg.enabled;
  }

  channelCfg.accounts = channelCfg.accounts || {};
  channelCfg.accounts.default = channelCfg.accounts.default || {};
  channelCfg.accounts.default.enabled = false;
  channelCfg.accounts.mux = channelCfg.accounts.mux || {};
  channelCfg.accounts.mux.enabled = true;
  channelCfg.accounts.mux.mux = {
    ...(channelCfg.accounts.mux.mux && typeof channelCfg.accounts.mux.mux === "object"
      ? channelCfg.accounts.mux.mux
      : {}),
    enabled: true,
    timeoutMs: 30000,
  };
}

cfg.plugins = cfg.plugins || {};
cfg.plugins.entries = cfg.plugins.entries || {};
for (const channel of ["telegram", "discord", "whatsapp"]) {
  const entry = cfg.plugins.entries[channel] || {};
  cfg.plugins.entries[channel] = { ...entry, enabled: true };
}

fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
NODE

compose restart openclaw >/dev/null
sleep 4

echo "[local-mux-e2e] stack is up"
echo "[local-mux-e2e] generate pairing token with: ${SCRIPT_DIR}/pair-token.sh telegram"
