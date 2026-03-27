#!/bin/sh
set -eu

bind="${OPENCLAW_GATEWAY_BIND:-loopback}"
port="${OPENCLAW_GATEWAY_PORT:-18789}"
allowed_origins_json="${OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS:-}"
workspace_dir="${OPENCLAW_WORKSPACE_DIR:-}"
sandbox_mode="${OPENCLAW_SANDBOX_MODE:-}"
tools_profile="${OPENCLAW_TOOLS_PROFILE:-}"
tools_allow_json="${OPENCLAW_TOOLS_ALLOW_JSON:-}"
tools_deny_json="${OPENCLAW_TOOLS_DENY_JSON:-}"
exec_host="${OPENCLAW_EXEC_HOST:-}"
exec_security="${OPENCLAW_EXEC_SECURITY:-}"
exec_ask="${OPENCLAW_EXEC_ASK:-}"

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

if [ -n "$sandbox_mode" ]; then
  node /app/openclaw.mjs config set agents.defaults.sandbox.mode "$sandbox_mode" >/dev/null
fi

if [ -n "$tools_profile" ]; then
  node /app/openclaw.mjs config set tools.profile "$tools_profile" >/dev/null
fi

if [ -n "$tools_allow_json" ]; then
  node /app/openclaw.mjs config set tools.allow "$tools_allow_json" --strict-json >/dev/null
fi

if [ -n "$tools_deny_json" ]; then
  node /app/openclaw.mjs config set tools.deny "$tools_deny_json" --strict-json >/dev/null
fi

if [ -n "$exec_host" ]; then
  node /app/openclaw.mjs config set tools.exec.host "$exec_host" >/dev/null
fi

if [ -n "$exec_security" ]; then
  node /app/openclaw.mjs config set tools.exec.security "$exec_security" >/dev/null
fi

if [ -n "$exec_ask" ]; then
  node /app/openclaw.mjs config set tools.exec.ask "$exec_ask" >/dev/null
fi

exec node /app/openclaw.mjs gateway run --allow-unconfigured --bind "$bind" --port "$port"
