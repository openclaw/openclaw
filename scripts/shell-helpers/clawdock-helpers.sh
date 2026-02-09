#!/usr/bin/env bash
# ClawDock - Docker helpers for OpenClaw
# Inspired by Simon Willison's "Running OpenClaw in Docker"
# https://til.simonwillison.net/llms/openclaw-docker
#
# Installation:
#   source <(curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh)
#
# Usage:
#   clawdock-help    # Show all available commands

# OpenClaw project directory (auto-detect or set manually)
CLAWDOCK_DIR="${CLAWDOCK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Start openclaw gateway
alias clawdock-start="docker compose -f ${CLAWDOCK_DIR}/docker-compose.yml up -d openclaw-gateway"

# Stop openclaw gateway
alias clawdock-stop="docker compose -f ${CLAWDOCK_DIR}/docker-compose.yml down"

# Restart openclaw gateway
alias clawdock-restart="docker compose -f ${CLAWDOCK_DIR}/docker-compose.yml restart openclaw-gateway"

# View openclaw logs
alias clawdock-logs="docker compose -f ${CLAWDOCK_DIR}/docker-compose.yml logs -f openclaw-gateway"

# Check openclaw status
alias clawdock-status="docker compose -f ${CLAWDOCK_DIR}/docker-compose.yml ps"

# Open openclaw directory
alias clawdock-cd="cd ${CLAWDOCK_DIR}"

# Shell into openclaw container (with openclaw alias pre-configured)
clawdock-shell() {
  docker compose -f "${CLAWDOCK_DIR}/docker-compose.yml" exec openclaw-gateway \
    bash -c 'echo "alias openclaw=\"./openclaw.mjs\"" > /tmp/.bashrc_openclaw && bash --rcfile /tmp/.bashrc_openclaw'
}

# Rebuild openclaw Docker image
alias clawdock-rebuild="docker compose -f ${CLAWDOCK_DIR}/docker-compose.yml build openclaw-gateway"

# Open config directory
alias clawdock-config="cd ~/.openclaw"

# Open workspace directory
alias clawdock-workspace="cd ~/.openclaw/workspace"

# Clean up containers and volumes (nuclear option)
alias clawdock-clean="docker compose -f ${CLAWDOCK_DIR}/docker-compose.yml down -v --remove-orphans"

# Health check
clawdock-health() {
  docker compose -f "${CLAWDOCK_DIR}/docker-compose.yml" exec openclaw-gateway \
    node dist/index.js health --token "$(grep OPENCLAW_GATEWAY_TOKEN ${CLAWDOCK_DIR}/.env | cut -d'=' -f2)"
}

# Show gateway token
clawdock-token() {
  grep OPENCLAW_GATEWAY_TOKEN "${CLAWDOCK_DIR}/.env" | cut -d'=' -f2
}

# Execute command in container
clawdock-exec() {
  docker compose -f "${CLAWDOCK_DIR}/docker-compose.yml" exec openclaw-gateway "$@"
}

# Run interactive CLI commands (dedicated CLI container)
alias clawdock-cli="docker compose -f ${CLAWDOCK_DIR}/docker-compose.yml run --rm openclaw-cli"

# Fix token configuration (run this once after setup)
clawdock-fix-token() {
  echo "🔧 Configuring gateway token..."
  local token=$(clawdock-token)
  if [[ -z "$token" ]]; then
    echo "❌ Error: Could not find gateway token"
    echo "   Check: ${CLAWDOCK_DIR}/.env"
    return 1
  fi

  echo "📝 Setting token: ${token:0:20}..."

  # Set both tokens directly (simpler approach)
  docker compose -f "${CLAWDOCK_DIR}/docker-compose.yml" exec openclaw-gateway \
    bash -c "./openclaw.mjs config set gateway.remote.token '$token' && ./openclaw.mjs config set gateway.auth.token '$token'" 2>&1 | grep -v "^WARN\|^time="

  echo "🔍 Verifying token was saved..."
  local saved_token=$(docker compose -f "${CLAWDOCK_DIR}/docker-compose.yml" exec openclaw-gateway \
    bash -c "./openclaw.mjs config get gateway.remote.token 2>/dev/null" 2>&1 | grep -v "^WARN\|^time=" | tr -d '\r\n' | head -c 64)

  if [[ "$saved_token" == "$token" ]]; then
    echo "✅ Token saved correctly!"
  else
    echo "⚠️  Token mismatch detected"
    echo "   Expected: ${token:0:20}..."
    echo "   Got: ${saved_token:0:20}..."
  fi

  echo "🔄 Restarting gateway..."
  docker compose -f "${CLAWDOCK_DIR}/docker-compose.yml" restart openclaw-gateway 2>&1 | grep -v "^WARN\|^time="

  echo "⏳ Waiting for gateway to start..."
  sleep 5

  echo "✅ Configuration complete!"
  echo "   Try: clawdock-devices"
}

# Open dashboard in browser
clawdock-dashboard() {
  echo "🦞 Getting dashboard URL..."
  local url=$(docker compose -f "${CLAWDOCK_DIR}/docker-compose.yml" run --rm openclaw-cli dashboard --no-open 2>&1 | grep -v "^WARN\|^time=" | grep -o 'http[s]\?://[^[:space:]]*')

  if [[ -n "$url" ]]; then
    echo "✅ Opening: $url"
    open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || echo "   Please open manually: $url"
    echo ""
    echo "💡 If you see 'pairing required' error:"
    echo "   1. Run: clawdock-devices"
    echo "   2. Copy the Request ID from the Pending table"
    echo "   3. Run: clawdock-approve <request-id>"
  else
    echo "❌ Failed to get dashboard URL"
    echo "   Try restarting: clawdock-restart"
  fi
}

# List device pairings
clawdock-devices() {
  echo "🔍 Checking device pairings..."
  docker compose -f "${CLAWDOCK_DIR}/docker-compose.yml" exec openclaw-gateway \
    node dist/index.js devices list 2>&1 | grep -v "^WARN\|^time="

  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo ""
    echo "💡 If you see token errors above:"
    echo "   1. Verify token is set: clawdock-token"
    echo "   2. Try manual config inside container:"
    echo "      clawdock-shell"
    echo "      openclaw config get gateway.remote.token"
    return 1
  fi

  echo ""
  echo "💡 To approve a pairing request:"
  echo "   clawdock-approve <request-id>"
}

# Approve device pairing request
clawdock-approve() {
  if [[ -z "$1" ]]; then
    echo "❌ Usage: clawdock-approve <request-id>"
    echo ""
    echo "💡 How to approve a device:"
    echo "   1. Run: clawdock-devices"
    echo "   2. Find the Request ID in the Pending table (long UUID)"
    echo "   3. Run: clawdock-approve <that-request-id>"
    echo ""
    echo "Example:"
    echo "   clawdock-approve 6f9db1bd-a1cc-4d3f-b643-2c195262464e"
    return 1
  fi

  echo "✅ Approving device: $1"
  docker compose -f "${CLAWDOCK_DIR}/docker-compose.yml" exec openclaw-gateway \
    node dist/index.js devices approve "$1" 2>&1 | grep -v "^WARN\|^time="

  echo ""
  echo "✅ Device approved! Refresh your browser."
}

# Show all available clawdock helper commands
clawdock-help() {
  # Colors
  local CYAN='\033[0;36m'
  local BOLD='\033[1m'
  local GREEN='\033[0;32m'
  local YELLOW='\033[1;33m'
  local BLUE='\033[0;34m'
  local MAGENTA='\033[0;35m'
  local RED='\033[0;31m'
  local RESET='\033[0m'
  local DIM='\033[2m'

  echo -e "\n${BOLD}${CYAN}🦞 ClawDock - Docker Helpers for OpenClaw${RESET}\n"

  echo -e "${BOLD}${MAGENTA}⚡ Basic Operations${RESET}"
  echo -e "  ${BOLD}clawdock-start${RESET}       ${DIM}Start the gateway${RESET}"
  echo -e "  ${BOLD}clawdock-stop${RESET}        ${DIM}Stop the gateway${RESET}"
  echo -e "  ${BOLD}clawdock-restart${RESET}     ${DIM}Restart the gateway${RESET}"
  echo -e "  ${BOLD}clawdock-status${RESET}      ${DIM}Check container status${RESET}"
  echo -e "  ${BOLD}clawdock-logs${RESET}        ${DIM}View live logs (follows)${RESET}"
  echo ""

  echo -e "${BOLD}${MAGENTA}🐚 Container Access${RESET}"
  echo -e "  ${BOLD}clawdock-shell${RESET}       ${DIM}Shell into container (openclaw alias ready)${RESET}"
  echo -e "  ${BOLD}clawdock-cli${RESET}         ${DIM}Run CLI commands (e.g., clawdock-cli status)${RESET}"
  echo -e "  ${BOLD}clawdock-exec${RESET} ${CYAN}<cmd>${RESET}  ${DIM}Execute command in gateway container${RESET}"
  echo ""

  echo -e "${BOLD}${MAGENTA}🌐 Web UI & Devices${RESET}"
  echo -e "  ${BOLD}clawdock-dashboard${RESET}   ${DIM}Open web UI in browser ${YELLOW}(auto-guides you)${RESET}"
  echo -e "  ${BOLD}clawdock-devices${RESET}     ${DIM}List device pairings ${YELLOW}(auto-guides you)${RESET}"
  echo -e "  ${BOLD}clawdock-approve${RESET} ${CYAN}<id>${RESET} ${DIM}Approve device pairing ${YELLOW}(with examples)${RESET}"
  echo ""

  echo -e "${BOLD}${MAGENTA}⚙️  Setup & Configuration${RESET}"
  echo -e "  ${BOLD}clawdock-fix-token${RESET}   ${DIM}Configure gateway token ${YELLOW}(run once)${RESET}"
  echo ""

  echo -e "${BOLD}${MAGENTA}🔧 Maintenance${RESET}"
  echo -e "  ${BOLD}clawdock-rebuild${RESET}     ${DIM}Rebuild Docker image${RESET}"
  echo -e "  ${BOLD}clawdock-clean${RESET}       ${RED}⚠️  Remove containers & volumes (nuclear)${RESET}"
  echo ""

  echo -e "${BOLD}${MAGENTA}🛠️  Utilities${RESET}"
  echo -e "  ${BOLD}clawdock-health${RESET}      ${DIM}Run health check${RESET}"
  echo -e "  ${BOLD}clawdock-token${RESET}       ${DIM}Show gateway auth token${RESET}"
  echo -e "  ${BOLD}clawdock-cd${RESET}          ${DIM}Jump to openclaw project directory${RESET}"
  echo -e "  ${BOLD}clawdock-config${RESET}      ${DIM}Open config directory (~/.openclaw)${RESET}"
  echo -e "  ${BOLD}clawdock-workspace${RESET}   ${DIM}Open workspace directory${RESET}"
  echo ""

  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${GREEN}🚀 First Time Setup${RESET}"
  echo -e "${CYAN}  1.${RESET} ${GREEN}clawdock-start${RESET}          ${DIM}# Start the gateway${RESET}"
  echo -e "${CYAN}  2.${RESET} ${GREEN}clawdock-fix-token${RESET}      ${DIM}# Configure token${RESET}"
  echo -e "${CYAN}  3.${RESET} ${GREEN}clawdock-dashboard${RESET}      ${DIM}# Open web UI${RESET}"
  echo -e "${CYAN}  4.${RESET} ${GREEN}clawdock-devices${RESET}        ${DIM}# If pairing needed${RESET}"
  echo -e "${CYAN}  5.${RESET} ${GREEN}clawdock-approve${RESET} ${CYAN}<id>${RESET}   ${DIM}# Approve pairing${RESET}"
  echo ""

  echo -e "${BOLD}${GREEN}💬 WhatsApp Setup${RESET}"
  echo -e "  ${GREEN}clawdock-shell${RESET}"
  echo -e "    ${BLUE}>${RESET} ${GREEN}openclaw channels login --channel whatsapp${RESET}"
  echo -e "    ${BLUE}>${RESET} ${GREEN}openclaw status${RESET}"
  echo ""

  echo -e "${BOLD}${GREEN}📝 Quick Examples${RESET}"
  echo -e "  ${GREEN}clawdock-start${RESET} && ${GREEN}clawdock-logs${RESET}"
  echo -e "  ${GREEN}clawdock-dashboard${RESET}"
  echo -e "  ${GREEN}clawdock-devices${RESET}"
  echo -e "  ${GREEN}clawdock-cli${RESET} ${CYAN}channels login${RESET}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""

  echo -e "${YELLOW}💡 All commands guide you through next steps!${RESET}"
  echo -e "${BLUE}📚 Docs: ${RESET}${CYAN}https://docs.openclaw.ai${RESET}"
  echo ""
}

# Export functions so they're available in subshells
export -f clawdock-shell clawdock-health clawdock-token clawdock-exec
export -f clawdock-fix-token clawdock-dashboard clawdock-devices
export -f clawdock-approve clawdock-help
