#!/bin/sh
# Railway entrypoint for the OpenClaw gateway.
#
# 1) Writes the PaaS gateway config and DEEP-MERGES it into any existing config
#    file (so stored OAuth credentials / runtime state are preserved, never
#    clobbered). The baked config:
#      - Control UI host-header fallback + device-auth off (needed behind
#        Railway's proxy).
#      - Enables the bundled admin-http-rpc plugin so the Hypertransient MCP
#        server can reach POST /api/v1/admin/rpc.
#      - Sets the default agent model to Claude (Opus 4.8, Sonnet fallback, high
#        thinking) so it uses ANTHROPIC_API_KEY, not the v2026.6.9 openai default.
#      - Registers the Hypertransient MCP server as a client so the agent has its
#        tools on every boot. transport=streamable-http (the server is NOT sse),
#        auth=oauth (tokens live in OPENCLAW_STATE_DIR on the volume). The tool
#        filter excludes GitHub/Railway infra tools; n8n, Postman, OpenClaw admin,
#        and Shopify tools pass through.
# 2) Railway mounts the persistent volume ROOT-owned at /home/node/.openclaw, but
#    the gateway runs as `node`; chown it, then drop to node with HOME and
#    OPENCLAW_STATE_DIR pinned to the volume (so state lands there, not /root).
set -e

NODE_HOME="/home/node"
STATE_DIR="${OPENCLAW_STATE_DIR:-$NODE_HOME/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/app/.openclaw/openclaw.json}"
GATEWAY="node --max-old-space-size=4096 openclaw.mjs gateway --bind lan --port ${PORT:-18789} --allow-unconfigured"

BASE_CONFIG='{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}},"plugins":{"entries":{"admin-http-rpc":{"enabled":true}}},"agents":{"defaults":{"model":{"primary":"anthropic/claude-opus-4-8","fallbacks":["anthropic/claude-sonnet-4-6"]},"thinkingDefault":"high"}},"mcp":{"servers":{"Hypertransient MCP Server":{"url":"https://mcp.hypertransient.com/mcp","transport":"streamable-http","auth":"oauth","toolFilter":{"exclude":["gh_*","railway_*"]}}}}}'

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

mkdir -p "$STATE_DIR/workspace" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  write_config
  chown -R node:node "$STATE_DIR" 2>/dev/null || true
  chown node:node "$NODE_HOME" 2>/dev/null || true
  chown node:node "$CONFIG_PATH" 2>/dev/null || true
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
