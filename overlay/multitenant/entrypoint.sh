#!/usr/bin/env bash
# Multi-tenant runtime entrypoint.
#
# Selects what runs in this container based on $MODE:
#   - subscription   : official `claude` / `codex` binaries running as the
#                      tenant's Pro/Max OAuth session. The container stays
#                      alive (broker in foreground) so the platform-context
#                      proxy can drive the binaries via the PTY-WS broker.
#   - byok           : OpenClaw gateway authenticated against the tenant's
#                      Anthropic / OpenAI API key (env vars).
#   - open-weights   : OpenClaw gateway pointed at a platform-hosted
#                      open-weights endpoint (cerebras / chutes / etc).
#
# In ALL modes we start the PTY-WebSocket broker (port 7681) in the
# background so the platform-context proxy can spawn claude/codex/bash
# PTYs at any time. In `byok` / `open-weights` the OpenClaw gateway runs
# in the foreground; in `subscription` we `wait -n` so signals propagate.
#
# Any extra args passed to the container are forwarded to the chosen
# command, so `docker run ... claude --version` still works.

set -euo pipefail

MODE="${MODE:-byok}"

# rockie-gpu CLI (Phase 5 step 5) reads these to talk to platform-context.
# ROCKIELAB_API_BASE defaults to the prod control-plane; per-tenant Fly
# env can override (e.g. https://api.dev.rockielab.com).
export ROCKIELAB_API_BASE="${ROCKIELAB_API_BASE:-https://api.rockielab.com}"
# ROCKIELAB_TENANT_ID is the sole tenant identity source. The context
# API reads X-Tenant-Token literally as the tenant id, so broker tokens
# and legacy ROCKIELAB_TENANT_TOKEN secrets must never supply identity.
if [ -z "${ROCKIELAB_TENANT_ID:-}" ]; then
  printf '[entrypoint] ERROR: ROCKIELAB_TENANT_ID is required\n' >&2
  exit 1
fi
export ROCKIELAB_TENANT_TOKEN="$ROCKIELAB_TENANT_ID"
# OpenClaw gateway needs to listen on the Fly machine's external
# interface so platform-context can HTTP-proxy to it through the
# WireGuard tunnel. Fly's 6PN private network is IPv6-ONLY (addresses
# in fdaa::/16), so we bind to `::` (the IPv6 unspecified address)
# which on Linux dual-stack also accepts IPv4 connections — i.e. one
# bind covers both host-local IPv4 healthchecks and the [fdaa::]:18789
# inbound traffic from platform-context. Auth is gated by
# OPENCLAW_GATEWAY_TOKEN, so wide-binding is safe.
#
# Use OPENCLAW_BIND=lan (a mode the gateway CLI recognizes) together
# with --host so the CLI's bind-resolution stays out of the way; the
# --host literal wins.
OPENCLAW_BIND="${OPENCLAW_BIND:-lan}"
OPENCLAW_HOST="${OPENCLAW_HOST:-::}"
# Match the gateway's documented default (src/gateway/server.impl.ts:508)
# so platform-context's OpenClawGatewayBackend can hit it without per-
# tenant port config.
OPENCLAW_PORT="${OPENCLAW_PORT:-18789}"
BROKER_PORT="${BROKER_PORT:-7681}"

log() {
  printf '[entrypoint] %s\n' "$*" >&2
}

# Render /home/runtime/.claude/settings.json.j2 → settings.json with the
# tenant/lab/target-dir placeholders substituted. Missing env vars are
# best-effort: log a WARN, substitute empty, do NOT exit (byok/dev may
# not have LAB_ID until fly_provisioning_service is updated; see
# specs/runtime-platform-lab-id-env-2026-05-21.md).
render_settings_json() {
  local template="/home/runtime/.claude/settings.json.j2"
  local output="/home/runtime/.claude/settings.json"
  if [ ! -f "$template" ]; then
    log "WARN: settings.json.j2 render: template ${template} not present; skipping"
    return 0
  fi
  local lab_id="${PLATFORM_LAB_ID:-${LAB_ID:-}}"
  local tenant_id="${ROCKIELAB_TENANT_ID:-}"
  local target_dir="${PLATFORM_TARGET_DIR:-${TARGET_DIR:-/home/runtime}}"
  for var in lab_id tenant_id target_dir; do
    if [ -z "${!var}" ]; then
      log "WARN: settings.json.j2 render: ${var} unset, substituting empty"
    fi
  done
  # Escape sed metachars (\, &, |) so a future provisioner passing a
  # path like /srv/work&prod can't corrupt the rendered JSON. `|` is
  # our delimiter — escape it too.
  local esc='s/[\&|]/\\&/g'
  mkdir -p "$(dirname "$output")"
  sed \
    -e "s|{{ LAB_ID }}|$(printf '%s' "$lab_id" | sed -e "$esc")|g" \
    -e "s|{{ TENANT_ID }}|$(printf '%s' "$tenant_id" | sed -e "$esc")|g" \
    -e "s|{{ TARGET_DIR }}|$(printf '%s' "$target_dir" | sed -e "$esc")|g" \
    "$template" > "$output"
  if command -v python3 >/dev/null 2>&1 && \
     ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$output" 2>/dev/null; then
    log "WARN: settings.json.j2 render: ${output} failed JSON validation; continuing"
    return 0
  fi
  log "settings.json rendered → ${output} (lab=${lab_id:-<empty>}, tenant=${tenant_id:-<empty>}, target=${target_dir:-<empty>})"
}

# If the caller passed a command (e.g. `docker run image claude --version`),
# just run it. The mode router only kicks in when no command is given.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# --- settings.json render (must precede broker + any subscription CLI) -----
render_settings_json

# --- broker (always-on) -----------------------------------------------------
if [ -x /usr/local/bin/broker ]; then
  if [ -z "${BROKER_TENANT_TOKEN:-}" ]; then
    log "WARN: BROKER_TENANT_TOKEN unset; broker /ws + /spawn will refuse all requests."
  else
    log "broker: tenant token is set (length-only check)"
  fi
  log "broker: starting on :${BROKER_PORT}"
  /usr/local/bin/broker &
  BROKER_PID=$!
else
  log "WARN: /usr/local/bin/broker not present; skipping."
  BROKER_PID=
fi

# --- rockie-loop daemon (MVP step 9) ---------------------------------------
# Continuous autoresearch loop. Pops queued experiments, polls in-flight
# jobs, plans new candidates on idle. Lives at /opt/rockie-loop and runs
# in the background so the broker stays the foreground process Fly
# tracks for liveness.
if [ -x /usr/local/bin/rockie-loop ] && [ -n "${ROCKIELAB_TENANT_TOKEN:-}" ]; then
  log "rockie-loop: starting (api=${ROCKIELAB_API_BASE}, mode=${MODE})"
  /usr/local/bin/rockie-loop run >> /tmp/rockie-loop.log 2>&1 &
  LOOP_PID=$!
  log "rockie-loop: pid=${LOOP_PID}"
elif [ ! -x /usr/local/bin/rockie-loop ]; then
  log "WARN: /usr/local/bin/rockie-loop not present; autoresearch loop disabled."
  LOOP_PID=
else
  log "WARN: ROCKIELAB_TENANT_TOKEN unset; skipping rockie-loop (would 401)."
  LOOP_PID=
fi

case "$MODE" in
  subscription)
    log "MODE=subscription; tenant uses official claude/codex CLIs via OAuth."
    log "Available binaries: $(command -v claude || echo 'claude MISSING') / $(command -v codex || echo 'codex MISSING')"
    # The broker is the only foreground process; wait -n so SIGTERM kills it.
    if [ -n "${BROKER_PID:-}" ]; then
      wait -n "$BROKER_PID"
    else
      exec tail -f /dev/null
    fi
    ;;
  byok|open-weights)
    log "MODE=${MODE}; starting OpenClaw gateway on [${OPENCLAW_HOST}]:${OPENCLAW_PORT} (bind-mode=${OPENCLAW_BIND}, chat-completions=on)."

    # Gateway token: platform-context's OpenClawGatewayBackend sends
    # `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN`. Reuse the broker
    # token if no dedicated one is set (same per-tenant secret, same
    # role: proxy auth from platform-context). Without a token, the
    # gateway accepts unauthenticated requests, which is wrong on a
    # public Fly machine.
    if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ] && [ -n "${BROKER_TENANT_TOKEN:-}" ]; then
      export OPENCLAW_GATEWAY_TOKEN="$BROKER_TENANT_TOKEN"
      log "openclaw: gateway token reused from BROKER_TENANT_TOKEN"
    elif [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
      log "openclaw: dedicated gateway token set"
    else
      log "WARN: no OPENCLAW_GATEWAY_TOKEN and no BROKER_TENANT_TOKEN — gateway will be open."
    fi

    # Seed a minimal openclaw.json that pins the default agent model to
    # whatever provider the tenant's BYOK_PROVIDER says. Without this,
    # OpenClaw's hardcoded default is openai/gpt-5.5
    # (src/agents/defaults.ts:DEFAULT_PROVIDER/DEFAULT_MODEL), which
    # ignores the tenant's ANTHROPIC_API_KEY and surfaces as
    # "Error: internal error" on every chat completion.
    #
    # BYOK_PROVIDER is set by the wizard alongside ANTHROPIC_API_KEY (or
    # the equivalent provider key). BYOK_MODEL_ID is the user-picked
    # model id; we map that to OpenClaw's `provider/model` form here.
    #
    # We only seed the file if it doesn't already exist — re-launching a
    # tenant must not clobber any setup-wizard-managed config the
    # gateway may have written into the volume.
    CONFIG_DIR="$HOME/.openclaw"
    CONFIG_FILE="$CONFIG_DIR/openclaw.json"
    if [ "$MODE" = "byok" ] && [ -n "${BYOK_PROVIDER:-}" ]; then
      mkdir -p "$CONFIG_DIR"
      PROVIDER="${BYOK_PROVIDER}"
      MODEL_ID="${BYOK_MODEL_ID:-}"
      # If BYOK_MODEL_ID is already "provider/model", strip the
      # provider prefix; otherwise use the raw id (the wizard sets
      # bare ids like "claude-sonnet-4-20250514").
      case "$MODEL_ID" in
        */*) MODEL_ONLY="${MODEL_ID#*/}" ;;
        "")  MODEL_ONLY="" ;;
        *)   MODEL_ONLY="$MODEL_ID" ;;
      esac
      # Provider-specific default model when the user didn't pick one.
      if [ -z "$MODEL_ONLY" ]; then
        case "$PROVIDER" in
          anthropic) MODEL_ONLY="claude-sonnet-4-6" ;;
          openai)    MODEL_ONLY="gpt-5.5" ;;
          google)    MODEL_ONLY="gemini-3.1-pro-preview" ;;
          *)         MODEL_ONLY="" ;;
        esac
      fi
      if [ -n "$MODEL_ONLY" ]; then
        MODEL_REF="${PROVIDER}/${MODEL_ONLY}"
        log "openclaw: seeding ${CONFIG_FILE} with agents.defaults.model.primary=${MODEL_REF}"
        cat > "$CONFIG_FILE" <<EOF
{
  "gateway": { "mode": "local" },
  "agents": {
    "defaults": {
      "model": { "primary": "${MODEL_REF}" }
    }
  }
}
EOF
        chmod 600 "$CONFIG_FILE"
      else
        log "WARN: BYOK_PROVIDER=${PROVIDER} but no usable model — leaving default agent model untouched"
      fi
    fi

    # Wire mcp-rockie into the OpenClaw gateway (fleet-task #24).
    #
    # OpenClaw's config schema is `mcp.servers.<name>` (NESTED), not the
    # top-level `mcpServers.<name>` that the Claude/Codex CLIs use. See
    # `src/config/types.mcp.ts` (McpConfig.servers) +
    # `src/agents/bundle-mcp-config.ts` (loadMergedBundleMcpConfig reads
    # `cfg.mcp.servers`). The gateway merges this catalog into the
    # `/v1/chat/completions` agent loop on session start.
    #
    # We point at the same `/home/runtime/mcp-rockie/server.js` binary
    # that the subscription paths register via Dockerfile.multitenant.
    # mcp-rockie is stdio-only and reads ROCKIELAB_API_BASE,
    # ROCKIELAB_TENANT_DEV_TOKEN, ROCKIELAB_API_PASSWORD from env. We
    # set the env map explicitly (rather than relying on process-env
    # inheritance) for parity with the subscription mcp.json payload.
    #
    # Only seed for `byok` (and `open-weights`, since both reach this
    # branch). `jq --argjson` merges the block onto whatever the prior
    # write produced — preserving the existing `gateway.mode` and
    # `agents.defaults.model.primary` keys without clobbering.
    MCP_ROCKIE_BIN="/home/runtime/mcp-rockie/server.js"
    if [ -f "$MCP_ROCKIE_BIN" ]; then
      # If no prior config was seeded (no BYOK_PROVIDER), start from {}.
      if [ ! -f "$CONFIG_FILE" ]; then
        mkdir -p "$CONFIG_DIR"
        printf '%s' '{}' > "$CONFIG_FILE"
        chmod 600 "$CONFIG_FILE"
      fi
      MCP_SERVERS_JSON=$(jq -n \
        --arg bin "$MCP_ROCKIE_BIN" \
        --arg api_base "${ROCKIELAB_API_BASE:-}" \
        --arg tenant_token "${ROCKIELAB_TENANT_TOKEN:-}" \
        --arg password "${OPEN_NOTEBOOK_PASSWORD:-}" \
        '{
          rockie: {
            command: "node",
            args: [$bin],
            env: {
              ROCKIELAB_API_BASE: $api_base,
              ROCKIELAB_TENANT_DEV_TOKEN: $tenant_token,
              ROCKIELAB_API_PASSWORD: $password
            }
          }
        }')
      TMP_CONFIG=$(mktemp)
      if jq --argjson servers "$MCP_SERVERS_JSON" \
            '.mcp = ((.mcp // {}) | .servers = ((.servers // {}) + $servers))' \
            "$CONFIG_FILE" > "$TMP_CONFIG"; then
        mv "$TMP_CONFIG" "$CONFIG_FILE"
        chmod 600 "$CONFIG_FILE"
        log "openclaw: seeded mcp.servers.rockie -> ${MCP_ROCKIE_BIN}"
      else
        rm -f "$TMP_CONFIG"
        log "WARN: failed to merge mcp.servers.rockie into ${CONFIG_FILE}; BYOK chat agents will have no MCP tools"
      fi
    else
      log "WARN: ${MCP_ROCKIE_BIN} not present; BYOK chat agents will have no MCP tools"
    fi

    cd /app
    GATEWAY_ARGS=(--port "$OPENCLAW_PORT" --bind "$OPENCLAW_BIND" --host "$OPENCLAW_HOST")
    if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
      GATEWAY_ARGS+=(--token "$OPENCLAW_GATEWAY_TOKEN")
    else
      GATEWAY_ARGS+=(--auth none)
    fi
    GATEWAY_ARGS+=(--allow-unconfigured)
    # BYOK mode is fundamentally an OpenAI-compatible chat-completions
    # proxy from platform-context's perspective (see
    # platform-context/api/agent_backend.py:OpenClawGatewayBackend).
    # Open-weights mode also targets the same endpoint. Upstream
    # OpenClaw ships this route disabled-by-default, so we enable it
    # here for both modes. Subscription mode never reaches this branch.
    GATEWAY_ARGS+=(--openai-chat-completions)
    exec node /app/dist/index.js gateway "${GATEWAY_ARGS[@]}"
    ;;
  *)
    log "ERROR: unknown MODE=${MODE}; expected one of: subscription, byok, open-weights"
    exit 64
    ;;
esac
