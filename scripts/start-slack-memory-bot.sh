#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Start OpenClaw Slack Bot with Identity-Scoped Memory
#
# Spins up an OpenClaw gateway as a Slack bot with the full 4-plugin
# identity + memory stack:
#   1. persist-user-identity  (p=60) — /verify, /register, /whoami
#   2. persist-postgres       (p=50) — message persistence
#   3. auth-memory-gate       (p=40) — hard gate + [MEMORY_SCOPE]
#   4. memory-graphiti        (p=0)  — Zep Cloud knowledge graph
#
# The bot:
#   - Authenticates users via JWT token (/verify)
#   - Links Slack user IDs to canonical user records
#   - Gates conversation until user is identified (hardGate mode)
#   - Stores per-user memory in Zep Cloud, isolated by scope_key
#   - Recalls user-specific facts on every message
#
# Required environment variables:
#   DATABASE_URL          PostgreSQL connection string
#   SLACK_BOT_TOKEN       Slack bot token (xoxb-...)
#   SLACK_APP_TOKEN       Slack app token (xapp-...) for socket mode
#
# Optional:
#   GETZEP_API_KEY        Zep Cloud API key (enables graph memory)
#   JWT_SECRET            HMAC-SHA256 secret for /verify tokens
#   OPENCLAW_HARD_GATE    "1" to lock agent until verified (default: 1)
#   OPENCLAW_REQUIRE_VERIFIED  "1" to gate memory behind verification
#   OPENCLAW_PORT         Gateway port (default: 18789)
#
# Usage:
#   DATABASE_URL=postgresql://... SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
#     ./scripts/start-slack-memory-bot.sh
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ---------------------------------------------------------------------------
# Validate required vars
# ---------------------------------------------------------------------------

missing=()
[ -z "${DATABASE_URL:-}" ] && missing+=("DATABASE_URL")
[ -z "${SLACK_BOT_TOKEN:-}" ] && missing+=("SLACK_BOT_TOKEN")
[ -z "${SLACK_APP_TOKEN:-}" ] && missing+=("SLACK_APP_TOKEN")

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: Missing required environment variables:"
  for var in "${missing[@]}"; do
    echo "  - $var"
  done
  echo ""
  echo "Usage:"
  echo "  DATABASE_URL=postgresql://user:pass@localhost/mydb \\"
  echo "  SLACK_BOT_TOKEN=xoxb-... \\"
  echo "  SLACK_APP_TOKEN=xapp-... \\"
  echo "  ./scripts/start-slack-memory-bot.sh"
  exit 1
fi

HARD_GATE="${OPENCLAW_HARD_GATE:-1}"
REQUIRE_VERIFIED="${OPENCLAW_REQUIRE_VERIFIED:-0}"
PORT="${OPENCLAW_PORT:-18789}"
JWT_SECRET="${JWT_SECRET:-}"
ZEP_KEY="${GETZEP_API_KEY:-}"

# ---------------------------------------------------------------------------
# Generate openclaw.json
# ---------------------------------------------------------------------------

CONFIG_DIR="${ROOT_DIR}/.openclaw-slack-bot"
mkdir -p "$CONFIG_DIR"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"

# Build memory-graphiti config based on whether Zep key is set
if [ -n "$ZEP_KEY" ]; then
  GRAPHITI_CONFIG='"mode": "cloud", "apiKey": "'"$ZEP_KEY"'"'
else
  GRAPHITI_CONFIG='"mode": "cloud"'
fi

# Build auth config for persist-user-identity
AUTH_CONFIG=""
if [ -n "$JWT_SECRET" ]; then
  AUTH_CONFIG='"auth": { "mode": "jwt-hs256", "jwtSecret": "'"$JWT_SECRET"'" },'
fi

cat > "$CONFIG_FILE" <<JSONEOF
{
  "session": {
    "dmScope": "per-channel-peer"
  },
  "channels": {
    "slack": {
      "enabled": true,
      "mode": "socket",
      "botToken": "${SLACK_BOT_TOKEN}",
      "appToken": "${SLACK_APP_TOKEN}",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  },
  "plugins": {
    "enabled": true,
    "allow": [
      "persist-user-identity",
      "persist-postgres",
      "auth-memory-gate",
      "memory-graphiti"
    ],
    "entries": {
      "persist-user-identity": {
        "enabled": true,
        "config": {
          "databaseUrl": "${DATABASE_URL}",
          ${AUTH_CONFIG}
          "_comment": "Resolves who is talking. Provides /verify, /register, /whoami."
        }
      },
      "persist-postgres": {
        "enabled": true,
        "config": {
          "databaseUrl": "${DATABASE_URL}"
        }
      },
      "auth-memory-gate": {
        "enabled": true,
        "config": {
          "databaseUrl": "${DATABASE_URL}",
          "hardGate": $([ "$HARD_GATE" = "1" ] && echo "true" || echo "false"),
          "requireVerified": $([ "$REQUIRE_VERIFIED" = "1" ] && echo "true" || echo "false")
        }
      },
      "memory-graphiti": {
        "enabled": true,
        "config": {
          ${GRAPHITI_CONFIG},
          "groupIdStrategy": "identity",
          "autoCapture": true,
          "autoRecall": true,
          "maxFacts": 10
        }
      }
    },
    "slots": {
      "memory": "memory-graphiti"
    }
  }
}
JSONEOF

echo "==> Generated config: $CONFIG_FILE"
echo ""
echo "    Plugin stack:"
echo "      1. persist-user-identity (p=60) — /verify, /register, /whoami"
echo "      2. persist-postgres      (p=50) — message persistence"
echo "      3. auth-memory-gate      (p=40) — identity gate"
echo "      4. memory-graphiti       (p=0)  — graph memory"
echo ""
echo "    Session:"
echo "      dmScope: per-channel-peer"
echo "      → session keys: agent:main:slack:direct:{slackUserId}"
echo ""
echo "    Slack:"
echo "      mode: socket (real-time WebSocket)"
echo "      DMs: open to all users"
echo ""
echo "    Identity:"
echo "      hardGate: $([ "$HARD_GATE" = "1" ] && echo "ON (agent locked until /verify or /register)" || echo "OFF")"
echo "      requireVerified: $([ "$REQUIRE_VERIFIED" = "1" ] && echo "ON (memory gated behind JWT)" || echo "OFF")"
echo "      JWT: $([ -n "$JWT_SECRET" ] && echo "configured (HS256)" || echo "not configured")"
echo ""
echo "    Memory:"
echo "      backend: $([ -n "$ZEP_KEY" ] && echo "Zep Cloud" || echo "Zep Cloud (needs GETZEP_API_KEY)")"
echo "      groupIdStrategy: identity (cross-channel)"
echo "      autoCapture: ON, autoRecall: ON"
echo ""

# ---------------------------------------------------------------------------
# Start gateway
# ---------------------------------------------------------------------------

echo "==> Starting OpenClaw gateway on port $PORT..."
echo "    Slack bot will connect via Socket Mode"
echo ""

export OPENCLAW_STATE_DIR="$CONFIG_DIR"
export DATABASE_URL
export GETZEP_API_KEY="${ZEP_KEY}"

# Use the generated config
exec pnpm openclaw gateway run \
  --config "$CONFIG_FILE" \
  --port "$PORT" \
  --verbose
