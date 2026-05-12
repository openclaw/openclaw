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

# If the caller passed a command (e.g. `docker run image claude --version`),
# just run it. The mode router only kicks in when no command is given.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

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
