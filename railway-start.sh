#!/bin/sh
set -eu

mkdir -p /data/.openclaw /data/workspace
chown -R node:node /data

OPENCLAW_RUNTIME_NPM_DIR="${OPENCLAW_RUNTIME_NPM_DIR:-/data/.openclaw/npm}"
mkdir -p "$OPENCLAW_RUNTIME_NPM_DIR"
chown -R node:node "$OPENCLAW_RUNTIME_NPM_DIR"

if [ ! -d "$OPENCLAW_RUNTIME_NPM_DIR/node_modules/openclaw" ] || \
  [ ! -d "$OPENCLAW_RUNTIME_NPM_DIR/node_modules/@openclaw/codex" ] || \
  ! su node -c "cd \"$OPENCLAW_RUNTIME_NPM_DIR\" && node -e \"import('openclaw/plugin-sdk/plugin-entry')\"" >/dev/null 2>&1; then
  echo "Repairing OpenClaw runtime npm cache in $OPENCLAW_RUNTIME_NPM_DIR..." >&2
  su node -c "cd \"$OPENCLAW_RUNTIME_NPM_DIR\" && npm install --omit=dev --no-audit --no-fund openclaw@2026.5.17 @openclaw/codex@2026.5.17"
fi

if [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  ORIGIN="https://${RAILWAY_PUBLIC_DOMAIN}"
  su node -c "node openclaw.mjs config set gateway.controlUi.allowedOrigins '[\"${ORIGIN}\"]' --strict-json"
fi

exec su node -c "tini -s -- node openclaw.mjs gateway --allow-unconfigured --bind lan --port ${PORT:-18789}"
