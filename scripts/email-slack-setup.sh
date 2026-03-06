#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║          OpenClaw — Email → Slack + Auto-Reply  |  One-Command Setup        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
# Usage:
#   chmod +x scripts/email-slack-setup.sh
#   ./scripts/email-slack-setup.sh
#
# What this does:
#   1. Checks prerequisites (Docker, Docker Compose)
#   2. Collects your Gmail address, Slack Bot Token, Slack channel, and AI key
#   3. Writes .env.email-digest with all settings
#   4. Builds openclaw:local + openclaw:email-digest Docker images
#   5. Starts the stack in the background
#   6. Authenticates Gmail inside the container
#   7. Registers the hourly cron job (every hour, polling Gmail)
#   8. Prints useful status and commands

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}▶${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC} $*"; }
error()   { echo -e "${RED}✗${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}── $* ──${NC}\n"; }
divider() { echo -e "${CYAN}────────────────────────────────────────────────────${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.email-digest"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
DIGEST_DIR="$OPENCLAW_CONFIG_DIR/digests"
GOG_CONFIG_DIR="${GOG_CONFIG_DIR:-$HOME/.config/gog}"
CONTAINER_NAME="openclaw-email-digest"

echo ""
echo -e "${BOLD}${CYAN}📬  OpenClaw Email → Slack + Auto-Reply — Setup${NC}"
echo -e "    Gmail polling every hour · Slack notifications · Auto-acknowledge replies"
divider
echo ""

# ── Step 1: Prerequisites ─────────────────────────────────────────────────────
header "Step 1: Checking prerequisites"

if ! command -v docker &>/dev/null; then
  error "Docker is not installed."
  echo "  Install from: https://docs.docker.com/get-docker/"
  exit 1
fi
success "Docker: $(docker --version | head -1)"

if ! docker compose version &>/dev/null; then
  error "Docker Compose v2 is required ('docker compose', not 'docker-compose')."
  exit 1
fi
success "Docker Compose: $(docker compose version | head -1)"

# ── Step 2: Load existing config ──────────────────────────────────────────────
header "Step 2: Configuration"

if [[ -f "$ENV_FILE" ]]; then
  info "Found existing $ENV_FILE — loading previous values"
  set -a; source "$ENV_FILE" 2>/dev/null || true; set +a
fi

# Gateway token
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32 2>/dev/null || \
    python3 -c "import secrets; print(secrets.token_hex(32))")
  info "Generated new gateway token"
fi

# Gmail account
if [[ -z "${GOG_ACCOUNT:-}" ]]; then
  echo ""
  read -rp "  📧  Gmail address (e.g. you@gmail.com): " GOG_ACCOUNT
fi

# AI API key
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" && -z "${CLAUDE_AI_SESSION_KEY:-}" ]]; then
  echo ""
  echo -e "${YELLOW}No AI API key found.${NC}"
  read -rp "  🤖  Anthropic API key (sk-ant-..., or press Enter to skip): " ANTHROPIC_API_KEY
fi

# Slack Bot Token
if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  echo ""
  echo "  To get a Slack Bot Token:"
  echo "    1. Go to https://api.slack.com/apps → Create New App → From Scratch"
  echo "    2. Add OAuth scopes: chat:write, channels:read"
  echo "    3. Install app to workspace → copy 'Bot User OAuth Token' (xoxb-...)"
  echo ""
  read -rp "  💬  Slack Bot Token (xoxb-..., or press Enter to skip): " SLACK_BOT_TOKEN
fi

# Slack channel ID
if [[ -z "${DIGEST_SLACK_CHANNEL:-}" && -n "${SLACK_BOT_TOKEN:-}" ]]; then
  echo ""
  echo "  To find the Slack Channel ID:"
  echo "    Right-click the channel → View channel details → copy the ID (C0123456789)"
  echo ""
  read -rp "  #  Slack Channel ID (e.g. C0123456789): " DIGEST_SLACK_CHANNEL
fi

# Auto-reply setting
if [[ -z "${EMAIL_AUTOREPLY_ENABLED:-}" ]]; then
  echo ""
  read -rp "  📨  Enable auto-reply to new emails? (yes/no) [yes]: " AUTOREPLY_CHOICE
  AUTOREPLY_CHOICE="${AUTOREPLY_CHOICE:-yes}"
  if [[ "$AUTOREPLY_CHOICE" =~ ^[Yy] ]]; then
    EMAIL_AUTOREPLY_ENABLED="true"
    EMAIL_AUTOREPLY_FROM="${EMAIL_AUTOREPLY_FROM:-$GOG_ACCOUNT}"
  else
    EMAIL_AUTOREPLY_ENABLED="false"
    EMAIL_AUTOREPLY_FROM=""
  fi
fi

success "Configuration collected"

# ── Step 3: Create directories ────────────────────────────────────────────────
header "Step 3: Creating directories"

mkdir -p "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR" "$DIGEST_DIR" "$GOG_CONFIG_DIR"
chmod 755 "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR" "$DIGEST_DIR" 2>/dev/null || true
success "Config: $OPENCLAW_CONFIG_DIR"
success "Digests: $DIGEST_DIR"
success "gog config: $GOG_CONFIG_DIR"

# ── Step 4: Write .env.email-digest ──────────────────────────────────────────
header "Step 4: Writing .env.email-digest"

cat > "$ENV_FILE" << EOF
# OpenClaw — Email → Slack + Auto-Reply
# Generated by scripts/email-slack-setup.sh on $(date)
# Edit this file then restart: docker compose -f docker-compose.email-digest.yml --env-file .env.email-digest restart

# ── Paths ────────────────────────────────────────────────────────────────────
OPENCLAW_CONFIG_DIR=${OPENCLAW_CONFIG_DIR}
OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR}
DIGEST_DIR=${DIGEST_DIR}
GOG_CONFIG_DIR=${GOG_CONFIG_DIR}

# ── Ports ────────────────────────────────────────────────────────────────────
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790

# ── Auth ─────────────────────────────────────────────────────────────────────
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}

# ── AI Model API keys (fill in at least one) ─────────────────────────────────
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
CLAUDE_AI_SESSION_KEY=${CLAUDE_AI_SESSION_KEY:-}
CLAUDE_WEB_SESSION_KEY=${CLAUDE_WEB_SESSION_KEY:-}
CLAUDE_WEB_COOKIE=${CLAUDE_WEB_COOKIE:-}

# ── Gmail ────────────────────────────────────────────────────────────────────
GOG_ACCOUNT=${GOG_ACCOUNT}

# ── Slack ────────────────────────────────────────────────────────────────────
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-}
DIGEST_SLACK_CHANNEL=${DIGEST_SLACK_CHANNEL:-}

# ── Auto-reply ───────────────────────────────────────────────────────────────
EMAIL_AUTOREPLY_ENABLED=${EMAIL_AUTOREPLY_ENABLED:-false}
EMAIL_AUTOREPLY_FROM=${EMAIL_AUTOREPLY_FROM:-$GOG_ACCOUNT}

# ── Other delivery channels (optional) ───────────────────────────────────────
DIGEST_WHATSAPP_NUMBER=${DIGEST_WHATSAPP_NUMBER:-}
DIGEST_TELEGRAM_CHAT=${DIGEST_TELEGRAM_CHAT:-}
EOF

success "Wrote $ENV_FILE"

# ── Step 5: Build Docker images ───────────────────────────────────────────────
header "Step 5: Building Docker images (this may take 5-10 min on first run)"

cd "$REPO_ROOT"

info "Building openclaw:local (base image)..."
docker build -t openclaw:local . 2>&1 | tail -5
success "openclaw:local built"

info "Building openclaw:email-digest (adds gog + jq)..."
docker build -f Dockerfile.email-digest -t openclaw:email-digest . 2>&1 | tail -10
success "openclaw:email-digest built"

# ── Step 6: Start the stack ───────────────────────────────────────────────────
header "Step 6: Starting the stack"

docker compose --env-file "$ENV_FILE" -f docker-compose.email-digest.yml up -d
success "Stack started"

# Wait for gateway to be healthy
info "Waiting for gateway to become healthy..."
MAX_WAIT=60; WAITED=0
while ! docker exec "$CONTAINER_NAME" curl -sf http://localhost:18789/health &>/dev/null 2>&1; do
  if [[ $WAITED -ge $MAX_WAIT ]]; then
    warn "Gateway health check timed out after ${MAX_WAIT}s — it may still be starting."
    break
  fi
  sleep 3; WAITED=$((WAITED + 3))
done
if docker exec "$CONTAINER_NAME" curl -sf http://localhost:18789/health &>/dev/null 2>&1; then
  success "Gateway is healthy"
fi

# ── Step 7: Connect Slack to OpenClaw ────────────────────────────────────────
header "Step 7: Connecting Slack"

if [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
  docker exec "$CONTAINER_NAME" \
    node openclaw.mjs channels add \
      --channel slack \
      --token "${SLACK_BOT_TOKEN}" 2>/dev/null && success "Slack channel connected" \
    || warn "Could not add Slack automatically — you can do it manually (see instructions below)"
else
  warn "SLACK_BOT_TOKEN not set — Slack notifications will not be active."
  echo "  Add it later in $ENV_FILE and re-run this script."
fi

# ── Step 8: Gmail authentication ─────────────────────────────────────────────
header "Step 8: Gmail authentication"

echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  You need to authenticate Gmail inside the container.   │"
echo "  │  A browser window will open (or a link will be shown).  │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""

docker exec -it "$CONTAINER_NAME" \
  gog auth add "${GOG_ACCOUNT}" --services gmail,calendar && \
  success "Gmail authenticated: ${GOG_ACCOUNT}" || \
  warn "Gmail auth may not be complete — you can re-run: docker exec -it $CONTAINER_NAME gog auth add ${GOG_ACCOUNT} --services gmail,calendar"

# ── Step 9: Register hourly cron job ─────────────────────────────────────────
header "Step 9: Registering hourly email cron job"

# Build delivery instruction string
DELIVER_TO=""
[[ -n "${DIGEST_SLACK_CHANNEL:-}" ]] && DELIVER_TO+="Slack channel ${DIGEST_SLACK_CHANNEL}, "
[[ -n "${DIGEST_WHATSAPP_NUMBER:-}" ]] && DELIVER_TO+="WhatsApp ${DIGEST_WHATSAPP_NUMBER}, "
[[ -n "${DIGEST_TELEGRAM_CHAT:-}" ]] && DELIVER_TO+="Telegram ${DIGEST_TELEGRAM_CHAT}, "
DELIVER_TO="${DELIVER_TO%, }"
[[ -z "$DELIVER_TO" ]] && DELIVER_TO="web dashboard only (http://localhost:18789/digest)"

AUTOREPLY_NOTE=""
[[ "${EMAIL_AUTOREPLY_ENABLED:-false}" == "true" ]] && AUTOREPLY_NOTE=" Auto-reply to new leads and customers is ENABLED."

CRON_MSG="Run the email-digest skill. Gmail account: ${GOG_ACCOUNT}. Deliver digest to: ${DELIVER_TO}. Save JSON to ~/.openclaw/digests/.${AUTOREPLY_NOTE}"

docker exec "$CONTAINER_NAME" \
  node openclaw.mjs cron add \
    --name "Hourly Email Digest" \
    --schedule "0 * * * *" \
    --message "$CRON_MSG" \
    --session isolated 2>/dev/null && success "Hourly cron job registered (runs at :00 every hour)" \
  || warn "Could not register cron job automatically. See instructions below to add it manually."

# ── Final instructions ────────────────────────────────────────────────────────
divider
echo ""
echo -e "${BOLD}${GREEN}✅ Setup complete!${NC}"
echo ""
echo -e "  ${BOLD}Gateway:${NC}      http://localhost:18789"
echo -e "  ${BOLD}Dashboard:${NC}    http://localhost:18789/digest"
echo -e "  ${BOLD}Token:${NC}        ${OPENCLAW_GATEWAY_TOKEN:0:8}...  (full token in $ENV_FILE)"
echo -e "  ${BOLD}Gmail:${NC}        ${GOG_ACCOUNT}"
if [[ -n "${DIGEST_SLACK_CHANNEL:-}" ]]; then
echo -e "  ${BOLD}Slack:${NC}        #${DIGEST_SLACK_CHANNEL} (notified every hour)"
fi
if [[ "${EMAIL_AUTOREPLY_ENABLED:-false}" == "true" ]]; then
echo -e "  ${BOLD}Auto-reply:${NC}   ✓ Enabled (from: ${EMAIL_AUTOREPLY_FROM:-$GOG_ACCOUNT})"
fi
echo ""
echo -e "${BOLD}Useful commands:${NC}"
echo ""
echo -e "  ${CYAN}# Trigger digest immediately (test):${NC}"
echo -e "  docker exec -it $CONTAINER_NAME node openclaw.mjs agent --message 'Run email-digest skill now'"
echo ""
echo -e "  ${CYAN}# View live logs:${NC}"
echo -e "  docker compose -f docker-compose.email-digest.yml --env-file $ENV_FILE logs -f"
echo ""
echo -e "  ${CYAN}# List registered cron jobs:${NC}"
echo -e "  docker exec $CONTAINER_NAME node openclaw.mjs cron list"
echo ""
echo -e "  ${CYAN}# Stop the stack:${NC}"
echo -e "  docker compose -f docker-compose.email-digest.yml --env-file $ENV_FILE down"
echo ""
echo -e "  ${CYAN}# Restart after editing $ENV_FILE:${NC}"
echo -e "  docker compose -f docker-compose.email-digest.yml --env-file $ENV_FILE restart"
echo ""
divider
