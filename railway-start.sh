#!/bin/sh
set -eu

mkdir -p /data/.openclaw /data/workspace
chown -R node:node /data

if [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  ORIGIN="https://${RAILWAY_PUBLIC_DOMAIN}"
  su node -c "node openclaw.mjs config set gateway.controlUi.allowedOrigins '[\"${ORIGIN}\"]' --strict-json"
fi

exec su node -c "tini -s -- node openclaw.mjs gateway --allow-unconfigured --bind lan --port ${PORT:-18789}"
