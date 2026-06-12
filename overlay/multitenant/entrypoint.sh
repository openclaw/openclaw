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
export ROCKIELAB_API_URL="${ROCKIELAB_API_URL:-${ROCKIELAB_API_BASE}}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${PLATFORM_TARGET_DIR:-${TARGET_DIR:-/home/runtime}}}"
export OPENCLAW_SKILLS_DIR="${OPENCLAW_SKILLS_DIR:-${HOME:-/home/runtime}/.claude/skills}"
# ROCKIELAB_TENANT_ID is tenant identity. ROCKIELAB_TENANT_TOKEN is the
# tenant-scoped service/dev auth token sent as X-Tenant-Token. Some older
# helpers name the same auth secret ROCKIELAB_TENANT_DEV_TOKEN, so keep
# both auth aliases in sync while never aliasing either token to the id.
# Runtime clients send both X-Tenant-Token and X-Tenant-Id so auth and
# tenant scoping stay separate. The PTY broker inherits this PID-1 env
# before SSH sessions are created, so id-as-token aliasing breaks
# chat-spawned runtime API calls even when Fly SSH sees the correct
# secret later.
if [ -z "${ROCKIELAB_TENANT_ID:-}" ]; then
  printf '[entrypoint] ERROR: ROCKIELAB_TENANT_ID is required\n' >&2
  exit 1
fi
if [ -z "${ROCKIELAB_TENANT_TOKEN:-}" ] && [ -n "${ROCKIELAB_TENANT_DEV_TOKEN:-}" ]; then
  export ROCKIELAB_TENANT_TOKEN="${ROCKIELAB_TENANT_DEV_TOKEN}"
fi
if [ -z "${ROCKIELAB_TENANT_DEV_TOKEN:-}" ] && [ -n "${ROCKIELAB_TENANT_TOKEN:-}" ]; then
  export ROCKIELAB_TENANT_DEV_TOKEN="${ROCKIELAB_TENANT_TOKEN}"
fi
if [ -z "${ROCKIELAB_TENANT_TOKEN:-}" ]; then
  printf '[entrypoint] WARN: ROCKIELAB_TENANT_TOKEN is unset; token-gated platform APIs may 401\n' >&2
fi
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

sync_named_children() {
  local src_parent="${1:?source parent required}"
  local dest_parent="${2:?destination parent required}"
  if [ ! -d "$src_parent" ]; then
    return 0
  fi
  mkdir -p "$dest_parent"
  local src_child name dest_child
  for src_child in "$src_parent"/*; do
    [ -e "$src_child" ] || continue
    name="$(basename "$src_child")"
    dest_child="$dest_parent/$name"
    if [ -d "$src_child" ]; then
      mkdir -p "$dest_child"
      rsync -a --delete "$src_child/" "$dest_child/"
    else
      rsync -a "$src_child" "$dest_child"
    fi
  done
}

sync_platform_tree() {
  local src="${1:?source path required}"
  local dest="${2:?destination path required}"
  if [ ! -d "$src" ]; then
    return 0
  fi
  mkdir -p "$dest"
  rsync -a --delete "$src/" "$dest/"
}

remove_retired_platform_skill_artifacts() {
  local home_dir="${1:?home directory required}"
  local retired_skill
  for retired_skill in gpu-spend queue-refill scheduled-notes; do
    rm -rf \
      "$home_dir/.claude/skills/$retired_skill" \
      "$home_dir/.codex/skills/$retired_skill"
    rm -f \
      "$home_dir/.claude/commands/$retired_skill.md" \
      "$home_dir/.codex/commands/$retired_skill.md"
  done
}

# Tenant volumes mount over $HOME, so image-baked ~/.claude and ~/.codex
# content is invisible at runtime. Hydrate only platform-owned overlay paths
# from the immutable image bundle. Tenant files such as settings.json,
# mcp.json, backups/, .openclaw/, and unknown top-level data are untouched.
#
# skills/ and commands/ are copied one child directory/file at a time so a
# tenant-added sibling skill remains present. A same-name skill is treated as
# a platform skill collision and is reconciled to the image copy.
hydrate_platform_home_bundle() {
  local bundle="${ROCKIE_HOME_BUNDLE:-/opt/rockielab/home-bundle}"
  if [ ! -d "$bundle" ]; then
    log "WARN: hydrate_platform_home_bundle: ${bundle} not present; skipping"
    return 0
  fi

  local home_dir="${HOME:-/home/runtime}"
  local bundle_claude="$bundle/.claude"
  local bundle_codex="$bundle/.codex"
  local claude_home="$home_dir/.claude"
  local codex_home="$home_dir/.codex"

  if [ -d "$bundle_claude" ]; then
    mkdir -p "$claude_home"
    sync_named_children "$bundle_claude/skills" "$claude_home/skills"
    sync_named_children "$bundle_claude/commands" "$claude_home/commands"
    sync_platform_tree "$bundle_claude/hooks" "$claude_home/hooks"
    sync_platform_tree "$bundle_claude/platform-memory" "$claude_home/platform-memory"
    sync_platform_tree "$bundle_claude/platform-templates" "$claude_home/platform-templates"
    sync_platform_tree "$bundle_claude/platform-scripts" "$claude_home/platform-scripts"
    sync_platform_tree "$bundle_claude/platform-docs" "$claude_home/platform-docs"
  fi

  if [ -d "$bundle_codex" ]; then
    mkdir -p "$codex_home"
    sync_named_children "$bundle_codex/skills" "$codex_home/skills"
    sync_named_children "$bundle_codex/commands" "$codex_home/commands"
  fi

  remove_retired_platform_skill_artifacts "$home_dir"

  local claude_skill_count=0 codex_skill_count=0
  if [ -d "$claude_home/skills" ]; then
    claude_skill_count="$(find "$claude_home/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  fi
  if [ -d "$codex_home/skills" ]; then
    codex_skill_count="$(find "$codex_home/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  fi
  log "hydrate_platform_home_bundle: synced claude_skills=${claude_skill_count:-0} codex_skills=${codex_skill_count:-0} from ${bundle}"
}

# Render /home/runtime/.claude/settings.json.j2 → settings.json with the
# tenant/lab/target-dir placeholders substituted. Missing env vars are
# best-effort: log a WARN, substitute empty, do NOT exit (byok/dev may
# not have LAB_ID until fly_provisioning_service is updated; see
# specs/runtime-platform-lab-id-env-2026-05-21.md).
render_settings_json() {
  local template="/home/runtime/.claude/settings.json.j2"
  local bundle_template="${ROCKIE_HOME_BUNDLE:-/opt/rockielab/home-bundle}/.claude/settings.json.j2"
  local output="/home/runtime/.claude/settings.json"
  if [ ! -f "$template" ] && [ -f "$bundle_template" ]; then
    template="$bundle_template"
  fi
  if [ ! -f "$template" ]; then
    log "WARN: settings.json.j2 render: template ${template} not present; skipping"
    return 0
  fi
  local current_settings=""
  if [ -f "$output" ]; then
    current_settings="$(tr -d '[:space:]' < "$output")"
  fi
  if [ -f "$output" ] && [ -n "$current_settings" ] && [ "$current_settings" != "{}" ]; then
    log "settings.json render: ${output} already exists; preserving tenant-managed file"
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

# NOTE — git credential + identity pre-wire moved to BUILD TIME
# (rockie-workspace#575 rework). It previously lived here as an
# entrypoint-time shell function, but the ENTRYPOINT runs AFTER the
# `USER runtime` directive in Dockerfile.multitenant, so this script
# executes as the unprivileged `runtime` user — which cannot
# `git config --system` (root-owned /etc/gitconfig → "Permission denied").
#
# The `--system` scope is required: the broker `/spawn` + `/ws` PTY spawn
# the agent shell as **root**, which reads /etc/gitconfig, never the
# `runtime` user's /home/runtime/.gitconfig (the --global scope). So the
# credential helpers (github.com + gist.github.com via `gh auth
# git-credential`, huggingface.co via git-credential-hf-env.sh) and the
# default identity are registered by Dockerfile.multitenant RUN steps that
# run as root *before* `USER runtime`. The helpers read GH_TOKEN / HF_TOKEN
# at git-invocation time and emit nothing when their token is absent, so a
# BYOK / open-weights tenant is unaffected. See the credential-helper block
# in Dockerfile.multitenant.

# Warm the subscription binary at machine start so the first user-facing
# call isn't a cold-start (#1222 S4). Runs ONE `--version` in the
# background, best-effort: never blocks broker startup, never fails the
# container. DISABLE_AUTOUPDATER / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
# are baked into the image (Dockerfile.multitenant), so this warm call
# cannot trigger a self-update or hang on a version ping. A short timeout
# guards against a wedged binary. Version is owned CENTRALLY via the image,
# never self-updated per machine.
warm_subscription_binary() {
  # Pick the binary the tenant actually uses; default to claude.
  local bin="${BINARY:-claude}"
  case "$bin" in
    claude|codex) : ;;
    *) bin="claude" ;;
  esac
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "warm: ${bin} not on PATH; skipping warm-up"
    return 0
  fi
  # Belt-and-suspenders: export the autoupdater-off vars in case the image
  # ENV was overridden by per-machine Fly env, so the warm call can never
  # itself fire an update.
  export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
  log "warm: warming ${bin} --version in background (autoupdater disabled)"
  (
    if command -v timeout >/dev/null 2>&1; then
      timeout 20 "$bin" --version >/dev/null 2>&1 \
        && log "warm: ${bin} warmed" \
        || log "warm: ${bin} warm-up exited non-zero (non-fatal)"
    else
      "$bin" --version >/dev/null 2>&1 \
        && log "warm: ${bin} warmed" \
        || log "warm: ${bin} warm-up exited non-zero (non-fatal)"
    fi
  ) &
}

# If the caller passed a command (e.g. `docker run image claude --version`),
# just run it. The mode router only kicks in when no command is given.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# --- platform-owned home overlay + settings render (must precede broker) ----
hydrate_platform_home_bundle

# --- user-authored private skills (Phase A, S2) -----------------------------
# Materialize the tenant's web-authored skills under ~/.claude/skills so the
# subscription claude/codex binaries and the byok gateway load them. Best-effort
# and idempotent; the per-session SessionStart hook (settings.json.j2) re-runs
# this so skills authored after boot appear without a Fly restart.
if [ -x /usr/local/bin/sync-user-skills.sh ]; then
  /usr/local/bin/sync-user-skills.sh || log "WARN: initial user-skill sync failed (non-fatal)"
else
  log "WARN: /usr/local/bin/sync-user-skills.sh not present; user skills will not load."
fi

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
    # Warm the chosen binary so the first user-facing spawn isn't cold (#1222 S4).
    warm_subscription_binary
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
    # ROCKIELAB_TENANT_DEV_TOKEN, ROCKIELAB_TENANT_ID, and
    # ROCKIELAB_API_PASSWORD from env. We
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
        --arg api_url "${ROCKIELAB_API_URL:-}" \
        --arg tenant_token "${ROCKIELAB_TENANT_TOKEN:-}" \
        --arg tenant_id "${ROCKIELAB_TENANT_ID:-}" \
        --arg password "${OPEN_NOTEBOOK_PASSWORD:-}" \
        '{
          rockie: {
            command: "node",
            args: [$bin],
            env: {
              ROCKIELAB_API_BASE: $api_base,
              ROCKIELAB_API_URL: $api_url,
              ROCKIELAB_TENANT_DEV_TOKEN: $tenant_token,
              ROCKIELAB_TENANT_ID: $tenant_id,
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
