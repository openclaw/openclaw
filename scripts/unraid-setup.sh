#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-/mnt/user/appdata/moltbot}"
ENV_FILE="${TARGET_DIR}/.env"
COMPOSE_FILE="${TARGET_DIR}/docker-compose.unraid.yml"

mkdir -p "${TARGET_DIR}/config" "${TARGET_DIR}/workspace"
chown -R 1000:1000 "${TARGET_DIR}/config" "${TARGET_DIR}/workspace"

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  cp "${ROOT_DIR}/docker-compose.unraid.yml" "${COMPOSE_FILE}"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 32)"
  else
    TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
  cat >"${ENV_FILE}" <<EOF
CLAWDBOT_IMAGE=moltbot:local
CLAWDBOT_GATEWAY_TOKEN=${TOKEN}
CLAWDBOT_GATEWAY_PORT=18789
CLAWDBOT_GATEWAY_BIND=lan
EOF
fi

cat <<EOF
Unraid setup complete.

Next steps:
  - Build or pull the image:
      docker build -t moltbot:local "${ROOT_DIR}"
  - Start the gateway:
      docker compose -f "${COMPOSE_FILE}" up -d moltbot-gateway
  - Run onboarding (TTY required):
      docker compose -f "${COMPOSE_FILE}" run --rm moltbot-cli onboard --no-install-daemon

Control UI (secure context required):
  ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
  http://127.0.0.1:18789/?token=<gateway-token>

Pairing (if prompted):
  docker compose -f "${COMPOSE_FILE}" exec -e CLAWDBOT_GATEWAY_TOKEN="<gateway-token>" \
    moltbot-gateway node dist/index.js devices list
  docker compose -f "${COMPOSE_FILE}" exec -e CLAWDBOT_GATEWAY_TOKEN="<gateway-token>" \
    moltbot-gateway node dist/index.js devices approve <requestId>
EOF
