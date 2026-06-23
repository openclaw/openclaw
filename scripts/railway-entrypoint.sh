#!/bin/sh
# Railway entrypoint for the OpenClaw gateway.
#
# Persistence + config:
#   - OpenClaw resolves its config dir relative to the /app workdir
#     (/app/.openclaw), which is part of the image and is WIPED on every
#     redeploy -- that's why OAuth tokens written by `openclaw mcp login` did not
#     survive. We symlink /app/.openclaw onto the Railway volume (mounted at
#     $STATE_DIR = /home/node/.openclaw) so the config file AND the OAuth tokens
#     (mcp-oauth/) persist across redeploys. The symlink is idempotent.
#   - write_config DEEP-MERGES the baked PaaS config into any existing config so
#     stored OAuth credentials / runtime state are preserved, never clobbered:
#       * Control UI host-header fallback + device-auth off (behind Railway proxy)
#       * admin-http-rpc plugin enabled (Hypertransient MCP -> POST /api/v1/admin/rpc)
#       * default agent model = Claude Opus 4.8 (Sonnet fallback, high thinking)
#       * heartbeat disabled (every:0m) -- no periodic token burn; trigger manually
#       * Hypertransient MCP server registered as a client (streamable-http, oauth;
#         GitHub/Railway infra tools filtered out; n8n, Postman, OpenClaw admin,
#         Shopify pass through)
#   - Railway mounts the volume ROOT-owned; chown it, then drop to node with HOME
#     and OPENCLAW_STATE_DIR pinned to the volume.
set -e

NODE_HOME="/home/node"
STATE_DIR="${OPENCLAW_STATE_DIR:-$NODE_HOME/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/app/.openclaw/openclaw.json}"
GATEWAY="node --max-old-space-size=4096 openclaw.mjs gateway --bind lan --port ${PORT:-18789} --allow-unconfigured"

BASE_CONFIG='{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}},"plugins":{"entries":{"admin-http-rpc":{"enabled":true}}},"agents":{"defaults":{"model":{"primary":"anthropic/claude-opus-4-8","fallbacks":["anthropic/claude-sonnet-4-6"]},"thinkingDefault":"high","heartbeat":{"every":"0m"}}},"mcp":{"servers":{"Hypertransient MCP Server":{"url":"https://mcp.hypertransient.com/mcp","transport":"streamable-http","auth":"oauth","toolFilter":{"exclude":["gh_*","railway_*"]}}}}}'

write_config() {
  mkdir -p "$(dirname "$CONFIG_PATH")" 2>/dev/null || true
  if command -v node >/dev/null 2>&1; then
    BASE_CONFIG="$BASE_CONFIG" CONFIG_PATH="$CONFIG_PATH" node -e '
      const fs = require("fs");
      const p = process.env.CONFIG_PATH;
      const base = JSON.parse(process.env.BASE_CONFIG);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
      const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
      const merge = (a, b) => {
        const o = isObj(a) ? { ...a } : {};
        for (const k of Object.keys(b)) o[k] = isObj(o[k]) && isObj(b[k]) ? merge(o[k], b[k]) : b[k];
        return o;
      };
      fs.writeFileSync(p, JSON.stringify(merge(cur, base)));
    ' && return 0
  fi
  printf '%s\n' "$BASE_CONFIG" > "$CONFIG_PATH"
}

# Redirect OpenClaw's /app-relative config dir onto the persistent volume so the
# config file + OAuth tokens survive redeploys. Idempotent: once it's a symlink,
# leave it alone.
if [ ! -L /app/.openclaw ]; then
  rm -rf /app/.openclaw 2>/dev/null || true
  ln -s "$STATE_DIR" /app/.openclaw 2>/dev/null || true
fi

mkdir -p "$STATE_DIR/workspace" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  write_config
  chown -R node:node "$STATE_DIR" 2>/dev/null || true
  chown node:node "$NODE_HOME" 2>/dev/null || true
  chown -h node:node /app/.openclaw 2>/dev/null || true
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid node --regid node --init-groups \
      env HOME="$NODE_HOME" OPENCLAW_STATE_DIR="$STATE_DIR" sh -c "$GATEWAY"
  elif command -v gosu >/dev/null 2>&1; then
    exec gosu node env HOME="$NODE_HOME" OPENCLAW_STATE_DIR="$STATE_DIR" sh -c "$GATEWAY"
  else
    exec su -s /bin/sh node -c "HOME=$NODE_HOME OPENCLAW_STATE_DIR=$STATE_DIR $GATEWAY"
  fi
else
  write_config 2>/dev/null || true
  export HOME="$NODE_HOME"
  export OPENCLAW_STATE_DIR="$STATE_DIR"
  exec sh -c "$GATEWAY"
fi
