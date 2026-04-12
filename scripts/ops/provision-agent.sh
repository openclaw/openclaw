#!/usr/bin/env bash
set -euo pipefail

# ─── OpenClaw Agent Provisioner ─────────────────────────────────────────────
#
# Usage:
#   ./provision-agent.sh <name> <server> [--model <model>]
#
# Provisions a new agent on a Hetzner server by:
#   1. Deriving an agent ID from the display name
#   2. Checking the agent doesn't already exist
#   3. Auto-detecting the next available port pair
#   4. Creating the agent directory, docker.env, and openclaw.json
#   5. Starting the container and health-checking it
#
# Arguments:
#   name    - Agent display name (e.g. "familyorganizer")
#   server  - SSH host alias: 1stclaw (EU) or 2ndclaw (US)
#   --model - Optional model override (e.g. "venice/claude-sonnet-4-5")
#
# Prerequisites:
#   - SSH config with 1stclaw and 2ndclaw host entries
#   - At least one existing agent on the target server (for shared API keys)
#   - Target server has docker + compose installed

AGENTS_DIR="/root/.openclaw/agents"
COMPOSE_DIR="/opt/openclaw"
DASHBOARD_ORIGIN="https://openclaw-dashboard-296319693396.europe-west1.run.app"

# ── Args ──────────────────────────────────────────────────────────────────────
usage() {
  echo "Usage: provision-agent.sh <name> <server> [--model <model>]" >&2
  echo "  server: 1stclaw (EU) or 2ndclaw (US)" >&2
  exit 1
}

if [[ -z "${1:-}" || -z "${2:-}" ]]; then
  usage
fi

AGENT_NAME="$1"
SERVER="$2"
shift 2

MODEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="${2:-}"; shift 2 ;;
    *) echo "ERROR: Unknown option '$1'" >&2; usage ;;
  esac
done

if [[ "$SERVER" != "1stclaw" && "$SERVER" != "2ndclaw" ]]; then
  echo "ERROR: Unknown server '$SERVER'. Use 1stclaw or 2ndclaw." >&2
  exit 1
fi

# ── Derive agent ID ──────────────────────────────────────────────────────────
AGENT_ID=$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' _' '-' | sed 's/[^a-z0-9-]//g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')

if [[ -z "$AGENT_ID" ]]; then
  echo "ERROR: Could not derive agent ID from name '$AGENT_NAME'" >&2
  exit 1
fi

echo "======================================================"
echo "  OpenClaw Agent Provisioner"
echo "  Name:   ${AGENT_NAME}"
echo "  ID:     ${AGENT_ID}"
echo "  Server: ${SERVER}"
[[ -n "$MODEL" ]] && echo "  Model:  ${MODEL}"
echo "======================================================"

# ── Provision (single SSH session) ───────────────────────────────────────────
echo ""
echo "-> Provisioning on ${SERVER}..."

RESULT=$(ssh "$SERVER" bash <<REMOTE_EOF
set -euo pipefail

AGENTS_DIR="${AGENTS_DIR}"
AGENT_ID="${AGENT_ID}"
AGENT_NAME="${AGENT_NAME}"
MODEL="${MODEL}"
COMPOSE_DIR="${COMPOSE_DIR}"
DASHBOARD_ORIGIN="${DASHBOARD_ORIGIN}"

# ── 1. Idempotency check ────────────────────────────────────────────────────
if [[ -f "\${AGENTS_DIR}/\${AGENT_ID}/docker.env" ]]; then
  port=\$(grep '^OPENCLAW_GATEWAY_PORT=' "\${AGENTS_DIR}/\${AGENT_ID}/docker.env" | cut -d= -f2)
  echo "ALREADY_EXISTS:\${port}"
  exit 0
fi

# ── 2. Find next port pair ──────────────────────────────────────────────────
MAX_PORT=18788
for env_file in "\${AGENTS_DIR}"/*/docker.env; do
  [[ -f "\$env_file" ]] || continue
  for key in OPENCLAW_GATEWAY_PORT OPENCLAW_BRIDGE_PORT; do
    port=\$(grep -E "^\${key}=" "\$env_file" 2>/dev/null | cut -d= -f2 || true)
    [[ -z "\$port" ]] && continue
    if (( port > MAX_PORT )); then
      MAX_PORT=\$port
    fi
  done
done
# Next pair: gateway = next odd after max, bridge = gateway + 1
NEXT_GW=\$(( MAX_PORT + 1 ))
if (( NEXT_GW % 2 == 0 )); then
  NEXT_GW=\$(( NEXT_GW + 1 ))
fi
NEXT_BR=\$(( NEXT_GW + 1 ))

# ── 3. Read shared keys + image from existing agent ─────────────────────────
SOURCE_ENV=""
for env_file in "\${AGENTS_DIR}"/*/docker.env; do
  [[ -f "\$env_file" ]] || continue
  SOURCE_ENV="\$env_file"
  break
done
if [[ -z "\$SOURCE_ENV" ]]; then
  echo "ERROR: No existing agents found. Cannot copy shared API keys." >&2
  exit 1
fi

get_key() { grep -E "^\${1}=" "\$SOURCE_ENV" 2>/dev/null | cut -d= -f2 || echo ""; }
OPENCLAW_IMAGE=\$(get_key OPENCLAW_IMAGE)
OPENAI_API_KEY=\$(get_key OPENAI_API_KEY)
VENICE_API_KEY=\$(get_key VENICE_API_KEY)
BRAVE_API_KEY=\$(get_key BRAVE_API_KEY)
ELEVENLABS_API_KEY=\$(get_key ELEVENLABS_API_KEY)

# ── 4. Create directory structure ────────────────────────────────────────────
mkdir -p "\${AGENTS_DIR}/\${AGENT_ID}/workspace"

# ── 5. Write docker.env ─────────────────────────────────────────────────────
cat > "\${AGENTS_DIR}/\${AGENT_ID}/docker.env" <<ENV_EOF
# Core API keys shared across all agents on this server
OPENAI_API_KEY=\${OPENAI_API_KEY}
VENICE_API_KEY=\${VENICE_API_KEY}
BRAVE_API_KEY=\${BRAVE_API_KEY}
ELEVENLABS_API_KEY=\${ELEVENLABS_API_KEY}

# --- per-agent overrides ---
OPENCLAW_CONFIG_DIR=/root/.openclaw/agents/\${AGENT_ID}
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/agents/\${AGENT_ID}/workspace
OPENCLAW_GATEWAY_PORT=\${NEXT_GW}
OPENCLAW_BRIDGE_PORT=\${NEXT_BR}
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_IMAGE=\${OPENCLAW_IMAGE}
ENV_EOF

# ── 6. Write openclaw.json ──────────────────────────────────────────────────
if [[ -n "\$MODEL" ]]; then
  MODEL_BLOCK='"agents":{"defaults":{"model":{"primary":"'"\$MODEL"'","fallbacks":["openai/gpt-4.1-mini","openai/gpt-4o","openai/gpt-4o-mini"]},"compaction":{"mode":"safeguard"}}},'
else
  MODEL_BLOCK='"agents":{"defaults":{"model":{"primary":"venice/claude-sonnet-4-5","fallbacks":["openai/gpt-4.1-mini","openai/gpt-4o","openai/gpt-4o-mini"]},"compaction":{"mode":"safeguard"}}},'
fi

cat > "\${AGENTS_DIR}/\${AGENT_ID}/openclaw.json" <<JSON_EOF
{
  "auth": {
    "cooldowns": {
      "veniceMinUsdBalance": 0.05
    }
  },
  \${MODEL_BLOCK}
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true
  },
  "channels": {},
  "gateway": {
    "mode": "local",
    "controlUi": {
      "allowedOrigins": ["\${DASHBOARD_ORIGIN}"],
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
JSON_EOF

# ── 7. Fix ownership ────────────────────────────────────────────────────────
chown -R 1000:1000 "\${AGENTS_DIR}/\${AGENT_ID}"

# ── 8. Start container ──────────────────────────────────────────────────────
cd "\${COMPOSE_DIR}"
docker compose -p "\${AGENT_ID}" --env-file "\${AGENTS_DIR}/\${AGENT_ID}/docker.env" up -d openclaw-gateway 2>&1

# ── 9. Health check ─────────────────────────────────────────────────────────
HEALTHY=false
for _ in 1 2 3 4; do
  sleep 5
  STATUS=\$(docker inspect --format='{{.State.Status}}' "\${AGENT_ID}-openclaw-gateway-1" 2>/dev/null || echo "missing")
  if [[ "\$STATUS" == "running" ]]; then
    HEALTHY=true
    break
  fi
done

if [[ "\$HEALTHY" == true ]]; then
  echo "OK:\${NEXT_GW}:\${NEXT_BR}"
else
  echo "FAIL:\${NEXT_GW}:\${NEXT_BR}"
  docker logs "\${AGENT_ID}-openclaw-gateway-1" --tail 10 2>&1 || true
  exit 1
fi
REMOTE_EOF
)

# ── Parse result ─────────────────────────────────────────────────────────────
if echo "$RESULT" | grep -q "^ALREADY_EXISTS:"; then
  PORT=$(echo "$RESULT" | grep "^ALREADY_EXISTS:" | cut -d: -f2)
  echo ""
  echo "Agent '${AGENT_ID}' already exists on ${SERVER} (gateway port ${PORT})."
  echo "Nothing to do."
  exit 0
fi

if echo "$RESULT" | grep -q "^OK:"; then
  PORTS=$(echo "$RESULT" | grep "^OK:" | head -1)
  GW_PORT=$(echo "$PORTS" | cut -d: -f2)
  BR_PORT=$(echo "$PORTS" | cut -d: -f3)
  echo ""
  echo "======================================================"
  echo "  Agent provisioned successfully!"
  echo ""
  echo "  Agent ID:     ${AGENT_ID}"
  echo "  Server:       ${SERVER}"
  echo "  Gateway port: ${GW_PORT}"
  echo "  Bridge port:  ${BR_PORT}"
  echo "======================================================"
  exit 0
fi

if echo "$RESULT" | grep -q "^FAIL:"; then
  echo ""
  echo "ERROR: Container failed health check. Logs:" >&2
  echo "$RESULT" >&2
  exit 1
fi

# Unexpected output — print it for debugging
echo "$RESULT"
exit 1
