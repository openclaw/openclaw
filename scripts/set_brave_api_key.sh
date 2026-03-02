#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <BRAVE_API_KEY>"
  exit 1
fi

KEY="$1"
ROOT_DIR="/home/tjrgus/openclaw"
ENV_FILE="${ROOT_DIR}/.env"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}"
  exit 1
fi

if rg -q '^BRAVE_API_KEY=' "${ENV_FILE}"; then
  sed -i "s/^BRAVE_API_KEY=.*/BRAVE_API_KEY=${KEY}/" "${ENV_FILE}"
else
  printf '\nBRAVE_API_KEY=%s\n' "${KEY}" >> "${ENV_FILE}"
fi

echo "Updated BRAVE_API_KEY in ${ENV_FILE}"

cd "${ROOT_DIR}"
docker compose up -d >/dev/null

echo "Gateway BRAVE_API_KEY status:"
docker exec openclaw-openclaw-gateway-1 sh -lc 'if [ -n "${BRAVE_API_KEY:-}" ]; then echo "SET"; else echo "MISSING"; fi'
