#!/usr/bin/env bash
# Email Intelligence Digest — one-command setup
# Sets up the full stack: OpenClaw gateway + gog (Gmail/Calendar) + digest dashboard
#
# Usage:
#   ./scripts/email-digest-setup.sh
#
# What it does:
#   1. Checks prerequisites (Docker, gog auth)
#   2. Builds openclaw:local (base) + openclaw:email-digest (with gog)
#   3. Creates config directories and .env file
#   4. Starts the stack
#   5. Walks you through the cron job config
#   6. Verifies everything is running

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}▶${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC} $*"; }
error()   { echo -e "${RED}✗${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}── $* ──${NC}\n"; }

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.email-digest"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
DIGEST_DIR="$OPENCLAW_CONFIG_DIR/digests"
GOG_CONFIG_DIR="${GOG_CONFIG_DIR:-$HOME/.config/gog}"

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}📬 Email Intelligence Digest — Setup${NC}"
echo -e "   OpenClaw × Gmail × Google Calendar × Slack × WhatsApp × Telegram"
echo ""

# ── Step 1: Check prerequisites ───────────────────────────────────────────────
header "Step 1: Checking prerequisites"

# Docker
if ! command -v docker &>/dev/null; then
  error "Docker is not installed."
  echo "  Install from: https://docs.docker.com/get-docker/"
  exit 1
fi
success "Docker: $(docker --version | head -1)"

# Docker Compose
if ! docker compose version &>/dev/null; then
  error "Docker Compose v2 is not installed (need 'docker compose', not 'docker-compose')."
  exit 1
fi
success "Docker Compose: $(docker compose version | head -1)"

# gog (optional — warn if missing, since it's needed for Gmail)
if command -v gog &>/dev/null; then
  success "gog: $(gog --version 2>/dev/null | head -1 || echo 'installed')"

  # Check gog auth
  if gog auth list 2>/dev/null | grep -q "@"; then
    GOG_ACCOUNT_DETECTED=$(gog auth list 2>/dev/null | grep "@" | head -1 | awk '{print $1}')
    success "gog auth: $GOG_ACCOUNT_DETECTED"
    DEFAULT_GOG_ACCOUNT="$GOG_ACCOUNT_DETECTED"
  else
    warn "gog is installed but no Google account is authenticated."
    echo "  Run: gog auth credentials /path/to/client_secret.json"
    echo "  Then: gog auth add you@gmail.com --services gmail,calendar"
    DEFAULT_GOG_ACCOUNT=""
  fi
else
  warn "gog is not installed on the HOST — it will be installed inside the Docker image."
  echo "  After setup, authenticate: docker exec -it openclaw-email-digest gog auth add you@gmail.com --services gmail,calendar"
  DEFAULT_GOG_ACCOUNT=""
fi

# ── Step 2: Collect configuration ─────────────────────────────────────────────
header "Step 2: Configuration"

# Load existing .env if present
if [[ -f "$ENV_FILE" ]]; then
  info "Found existing $ENV_FILE — loading values"
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

# Gateway token
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))")
  info "Generated gateway token"
fi

# AI API key
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" && -z "${CLAUDE_AI_SESSION_KEY:-}" ]]; then
  echo ""
  echo -e "${YELLOW}No AI API key found in environment.${NC}"
  echo "  Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, or CLAUDE_AI_SESSION_KEY"
  echo "  You can add it to $ENV_FILE after setup."
fi

# gog account
if [[ -z "${GOG_ACCOUNT:-}" ]]; then
  GOG_ACCOUNT="${DEFAULT_GOG_ACCOUNT:-}"
  if [[ -z "$GOG_ACCOUNT" ]]; then
    echo ""
    read -rp "  Gmail address for digest (e.g. you@gmail.com): " GOG_ACCOUNT
  fi
fi

# Delivery targets
echo ""
info "Delivery channel configuration (press Enter to skip any channel):"
echo ""

if [[ -z "${DIGEST_SLACK_CHANNEL:-}" ]]; then
  read -rp "  Slack channel ID (e.g. C0123456789, or leave blank): " DIGEST_SLACK_CHANNEL
fi

if [[ -z "${DIGEST_WHATSAPP_NUMBER:-}" ]]; then
  read -rp "  WhatsApp number (e.g. +2547XXXXXXXX, or leave blank): " DIGEST_WHATSAPP_NUMBER
fi

if [[ -z "${DIGEST_TELEGRAM_CHAT:-}" ]]; then
  read -rp "  Telegram chat (e.g. @mychannel or +2547XXXXXXXX, or leave blank): " DIGEST_TELEGRAM_CHAT
fi

# ── Step 3: Create directories ────────────────────────────────────────────────
header "Step 3: Creating directories"

mkdir -p "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR" "$DIGEST_DIR" "$GOG_CONFIG_DIR"
success "Config dir: $OPENCLAW_CONFIG_DIR"
success "Digests dir: $DIGEST_DIR"
success "gog config: $GOG_CONFIG_DIR"

# Fix permissions so Docker (node uid=1000) can write
chmod 755 "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR" "$DIGEST_DIR"

# ── Step 4: Write .env file ───────────────────────────────────────────────────
header "Step 4: Writing configuration"

cat > "$ENV_FILE" << EOF
# Email Intelligence Digest — Environment
# Generated by scripts/email-digest-setup.sh on $(date)
# Edit this file to update your configuration, then restart:
#   docker compose -f docker-compose.email-digest.yml up -d

# ── OpenClaw paths ──────────────────────────────────────────────────────────
OPENCLAW_CONFIG_DIR=${OPENCLAW_CONFIG_DIR}
OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR}
DIGEST_DIR=${DIGEST_DIR}
GOG_CONFIG_DIR=${GOG_CONFIG_DIR}

# ── Ports ───────────────────────────────────────────────────────────────────
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790

# ── Auth ────────────────────────────────────────────────────────────────────
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}

# ── AI model API keys (fill in at least one) ────────────────────────────────
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
CLAUDE_AI_SESSION_KEY=${CLAUDE_AI_SESSION_KEY:-}
CLAUDE_WEB_SESSION_KEY=${CLAUDE_WEB_SESSION_KEY:-}
CLAUDE_WEB_COOKIE=${CLAUDE_WEB_COOKIE:-}

# ── gog Gmail account ───────────────────────────────────────────────────────
GOG_ACCOUNT=${GOG_ACCOUNT}

# ── Delivery targets ────────────────────────────────────────────────────────
DIGEST_SLACK_CHANNEL=${DIGEST_SLACK_CHANNEL}
DIGEST_WHATSAPP_NUMBER=${DIGEST_WHATSAPP_NUMBER}
DIGEST_TELEGRAM_CHAT=${DIGEST_TELEGRAM_CHAT}
EOF

success "Wrote $ENV_FILE"

# ── Step 5: Build Docker images ───────────────────────────────────────────────
header "Step 5: Building Docker images"

info "Building openclaw:local (base image — this takes a few minutes the first time)..."
cd "$REPO_ROOT"
docker build -t openclaw:local . 2>&1 | tail -5
success "openclaw:local built"

info "Building openclaw:email-digest (adds gog + jq — this installs Homebrew, ~5 min)..."
docker build -f Dockerfile.email-digest -t openclaw:email-digest . 2>&1 | tail -10
success "openclaw:email-digest built"

# ── Step 6: Start the stack ───────────────────────────────────────────────────
header "Step 6: Starting the stack"

# Load the .env file for compose
export $(grep -v '^#' "$ENV_FILE" | xargs -0 2>/dev/null || grep -v '^#' "$ENV_FILE" | xargs)

docker compose --env-file "$ENV_FILE" -f "$REPO_ROOT/docker-compose.email-digest.yml" up -d
success "Stack started"

# Wait for gateway to be healthy
info "Waiting for gateway to start..."
for i in {1..20}; do
  if docker exec openclaw-email-digest curl -sf http://localhost:18789 &>/dev/null 2>&1; then
    break
  fi
  sleep 2
done
success "Gateway is running"

# ── Step 7: Add cron job config ───────────────────────────────────────────────
header "Step 7: Setting up hourly cron job"

CRON_CONFIG_FILE="$OPENCLAW_CONFIG_DIR/cron-email-digest.json"

# Build delivery instruction based on what the user configured
DELIVER_TO=""
[[ -n "$DIGEST_SLACK_CHANNEL" ]]     && DELIVER_TO+="Slack channel $DIGEST_SLACK_CHANNEL, "
[[ -n "$DIGEST_WHATSAPP_NUMBER" ]]   && DELIVER_TO+="WhatsApp $DIGEST_WHATSAPP_NUMBER, "
[[ -n "$DIGEST_TELEGRAM_CHAT" ]]     && DELIVER_TO+="Telegram $DIGEST_TELEGRAM_CHAT, "
DELIVER_TO="${DELIVER_TO%, }"  # trim trailing comma
[[ -z "$DELIVER_TO" ]] && DELIVER_TO="the web dashboard only (http://localhost:18789/digest)"

CRON_MESSAGE="Run the email-digest skill. Gmail account: ${GOG_ACCOUNT}. Deliver to: ${DELIVER_TO}. Save the digest JSON to ~/.openclaw/digests/."

info "Cron job message: $CRON_MESSAGE"
info "Adding cron job via OpenClaw CLI..."

docker exec openclaw-email-digest \
  node openclaw.mjs cron add \
    --name "Hourly Email Digest" \
    --schedule "0 * * * *" \
    --message "$CRON_MESSAGE" \
    --session isolated 2>/dev/null && success "Cron job added" \
  || warn "Could not add cron job automatically. Add it manually — see instructions below."

# ── Step 8: Final instructions ────────────────────────────────────────────────
header "✅ Setup complete!"

echo -e "
${BOLD}Gateway:${NC}      http://localhost:${OPENCLAW_GATEWAY_PORT:-18789}
${BOLD}Dashboard:${NC}    http://localhost:${OPENCLAW_GATEWAY_PORT:-18789}/digest
${BOLD}Token:${NC}        ${OPENCLAW_GATEWAY_TOKEN:0:8}...  (full token in $ENV_FILE)

${BOLD}Next steps:${NC}

  1. Authenticate Gmail + Calendar (if not already done):
     ${CYAN}docker exec -it openclaw-email-digest gog auth add ${GOG_ACCOUNT:-you@gmail.com} --services gmail,calendar${NC}

  2. Run the digest manually to test:
     ${CYAN}docker exec -it openclaw-email-digest node openclaw.mjs agent --message 'Run email-digest skill now'${NC}

  3. Watch the digest dashboard live:
     ${CYAN}open http://localhost:${OPENCLAW_GATEWAY_PORT:-18789}/digest${NC}

  4. Connect your messaging channels (WhatsApp, Telegram, Slack):
     ${CYAN}docker exec -it openclaw-email-digest node openclaw.mjs channels status${NC}

  5. The cron job runs automatically every hour. View logs:
     ${CYAN}docker compose -f docker-compose.email-digest.yml logs -f${NC}

${BOLD}Useful commands:${NC}

  Stop:     ${CYAN}docker compose -f docker-compose.email-digest.yml down${NC}
  Restart:  ${CYAN}docker compose -f docker-compose.email-digest.yml restart${NC}
  Update:   ${CYAN}docker compose -f docker-compose.email-digest.yml pull && docker compose -f docker-compose.email-digest.yml up -d${NC}
  Shell:    ${CYAN}docker exec -it openclaw-email-digest bash${NC}

${BOLD}Config file:${NC}  $ENV_FILE
"
