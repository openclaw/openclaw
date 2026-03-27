#!/bin/sh
set -eu

bind="${OPENCLAW_GATEWAY_BIND:-loopback}"
port="${OPENCLAW_GATEWAY_PORT:-18789}"
allowed_origins_json="${OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS:-}"
workspace_dir="${OPENCLAW_WORKSPACE_DIR:-}"

if [ -z "${OPENCLAW_CONFIG_PATH:-}" ]; then
  state_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
  export OPENCLAW_CONFIG_PATH="${state_dir}/openclaw.json"
fi

if [ "$bind" != "loopback" ]; then
  if [ -z "$allowed_origins_json" ] && [ -n "${RENDER_EXTERNAL_URL:-}" ]; then
    origin="${RENDER_EXTERNAL_URL%/}"
    allowed_origins_json="[\"${origin}\"]"
  fi

  if [ -n "$allowed_origins_json" ]; then
    node /app/openclaw.mjs config set gateway.controlUi.allowedOrigins "$allowed_origins_json" --strict-json >/dev/null
  else
    node /app/openclaw.mjs config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true --strict-json >/dev/null
  fi
fi

if [ -n "$workspace_dir" ]; then
  install -d -m 0755 "$workspace_dir"
  node /app/openclaw.mjs config set agents.defaults.workspace "$workspace_dir" >/dev/null
fi

exec node /app/openclaw.mjs gateway run --allow-unconfigured --bind "$bind" --port "$port"
