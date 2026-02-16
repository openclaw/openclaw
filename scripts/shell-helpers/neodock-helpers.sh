#!/usr/bin/env bash
# NeoDock - Docker helpers for SmartAgentNeo
# Inspired by Simon Willison's "Running SmartAgentNeo in Docker"
# https://til.simonwillison.net/llms/smart-agent-neo-docker
#
# Installation:
#   mkdir -p ~/.neodock && curl -sL https://raw.githubusercontent.com/betterbrand/smart-agent-neo/main/scripts/shell-helpers/neodock-helpers.sh -o ~/.neodock/neodock-helpers.sh
#   echo 'source ~/.neodock/neodock-helpers.sh' >> ~/.zshrc
#
# Usage:
#   neodock-help    # Show all available commands

# =============================================================================
# Colors
# =============================================================================
_CLR_RESET='\033[0m'
_CLR_BOLD='\033[1m'
_CLR_DIM='\033[2m'
_CLR_GREEN='\033[0;32m'
_CLR_YELLOW='\033[1;33m'
_CLR_BLUE='\033[0;34m'
_CLR_MAGENTA='\033[0;35m'
_CLR_CYAN='\033[0;36m'
_CLR_RED='\033[0;31m'

# Styled command output (green + bold)
_clr_cmd() {
  echo -e "${_CLR_GREEN}${_CLR_BOLD}$1${_CLR_RESET}"
}

# Inline command for use in sentences
_cmd() {
  echo "${_CLR_GREEN}${_CLR_BOLD}$1${_CLR_RESET}"
}

# =============================================================================
# Config
# =============================================================================
NEODOCK_CONFIG="${HOME}/.neodock/config"

# Common paths to check for SmartAgentNeo
NEODOCK_COMMON_PATHS=(
  "${HOME}/smart-agent-neo"
  "${HOME}/workspace/smart-agent-neo"
  "${HOME}/projects/smart-agent-neo"
  "${HOME}/dev/smart-agent-neo"
  "${HOME}/code/smart-agent-neo"
  "${HOME}/src/smart-agent-neo"
)

_neodock_filter_warnings() {
  grep -v "^WARN\|^time="
}

_neodock_trim_quotes() {
  local value="$1"
  value="${value#\"}"
  value="${value%\"}"
  printf "%s" "$value"
}

_neodock_read_config_dir() {
  if [[ ! -f "$NEODOCK_CONFIG" ]]; then
    return 1
  fi
  local raw
  raw=$(sed -n 's/^NEODOCK_DIR=//p' "$NEODOCK_CONFIG" | head -n 1)
  if [[ -z "$raw" ]]; then
    return 1
  fi
  _neodock_trim_quotes "$raw"
}

# Ensure NEODOCK_DIR is set and valid
_neodock_ensure_dir() {
  # Already set and valid?
  if [[ -n "$NEODOCK_DIR" && -f "${NEODOCK_DIR}/docker-compose.yml" ]]; then
    return 0
  fi

  # Try loading from config
  local config_dir
  config_dir=$(_neodock_read_config_dir)
  if [[ -n "$config_dir" && -f "${config_dir}/docker-compose.yml" ]]; then
    NEODOCK_DIR="$config_dir"
    return 0
  fi

  # Auto-detect from common paths
  local found_path=""
  for path in "${NEODOCK_COMMON_PATHS[@]}"; do
    if [[ -f "${path}/docker-compose.yml" ]]; then
      found_path="$path"
      break
    fi
  done

  if [[ -n "$found_path" ]]; then
    echo ""
    echo "🦞 Found SmartAgentNeo at: $found_path"
    echo -n "   Use this location? [Y/n] "
    read -r response
    if [[ "$response" =~ ^[Nn] ]]; then
      echo ""
      echo "Set NEODOCK_DIR manually:"
      echo "  export NEODOCK_DIR=/path/to/smart-agent-neo"
      return 1
    fi
    NEODOCK_DIR="$found_path"
  else
    echo ""
    echo "❌ SmartAgentNeo not found in common locations."
    echo ""
    echo "Clone it first:"
    echo ""
    echo "  git clone https://github.com/betterbrand/smart-agent-neo.git ~/smart-agent-neo"
    echo "  cd ~/smart-agent-neo && ./docker-setup.sh"
    echo ""
    echo "Or set NEODOCK_DIR if it's elsewhere:"
    echo ""
    echo "  export NEODOCK_DIR=/path/to/smart-agent-neo"
    echo ""
    return 1
  fi

  # Save to config
  if [[ ! -d "${HOME}/.neodock" ]]; then
    /bin/mkdir -p "${HOME}/.neodock"
  fi
  echo "NEODOCK_DIR=\"$NEODOCK_DIR\"" > "$NEODOCK_CONFIG"
  echo "✅ Saved to $NEODOCK_CONFIG"
  echo ""
  return 0
}

# Wrapper to run docker compose commands
_neodock_compose() {
  _neodock_ensure_dir || return 1
  command docker compose -f "${NEODOCK_DIR}/docker-compose.yml" "$@"
}

_neodock_read_env_token() {
  _neodock_ensure_dir || return 1
  if [[ ! -f "${NEODOCK_DIR}/.env" ]]; then
    return 1
  fi
  local raw
  raw=$(sed -n 's/^SMART_AGENT_NEO_GATEWAY_TOKEN=//p' "${NEODOCK_DIR}/.env" | head -n 1)
  if [[ -z "$raw" ]]; then
    return 1
  fi
  _neodock_trim_quotes "$raw"
}

# Basic Operations
neodock-start() {
  _neodock_compose up -d smart-agent-neo-gateway
}

neodock-stop() {
  _neodock_compose down
}

neodock-restart() {
  _neodock_compose restart smart-agent-neo-gateway
}

neodock-logs() {
  _neodock_compose logs -f smart-agent-neo-gateway
}

neodock-status() {
  _neodock_compose ps
}

# Navigation
neodock-cd() {
  _neodock_ensure_dir || return 1
  cd "${NEODOCK_DIR}"
}

neodock-config() {
  cd ~/.smart-agent-neo
}

neodock-workspace() {
  cd ~/.smart-agent-neo/workspace
}

# Container Access
neodock-shell() {
  _neodock_compose exec smart-agent-neo-gateway \
    bash -c 'echo "alias smart-agent-neo=\"./smart-agent-neo.mjs\"" > /tmp/.bashrc_smart-agent-neo && bash --rcfile /tmp/.bashrc_smart-agent-neo'
}

neodock-exec() {
  _neodock_compose exec smart-agent-neo-gateway "$@"
}

neodock-cli() {
  _neodock_compose run --rm smart-agent-neo-cli "$@"
}

# Maintenance
neodock-rebuild() {
  _neodock_compose build smart-agent-neo-gateway
}

neodock-clean() {
  _neodock_compose down -v --remove-orphans
}

# Health check
neodock-health() {
  _neodock_ensure_dir || return 1
  local token
  token=$(_neodock_read_env_token)
  if [[ -z "$token" ]]; then
    echo "❌ Error: Could not find gateway token"
    echo "   Check: ${NEODOCK_DIR}/.env"
    return 1
  fi
  _neodock_compose exec -e "SMART_AGENT_NEO_GATEWAY_TOKEN=$token" smart-agent-neo-gateway \
    node dist/index.js health
}

# Show gateway token
neodock-token() {
  _neodock_read_env_token
}

# Fix token configuration (run this once after setup)
neodock-fix-token() {
  _neodock_ensure_dir || return 1

  echo "🔧 Configuring gateway token..."
  local token
  token=$(neodock-token)
  if [[ -z "$token" ]]; then
    echo "❌ Error: Could not find gateway token"
    echo "   Check: ${NEODOCK_DIR}/.env"
    return 1
  fi

  echo "📝 Setting token: ${token:0:20}..."

  _neodock_compose exec -e "TOKEN=$token" smart-agent-neo-gateway \
    bash -c './smart-agent-neo.mjs config set gateway.remote.token "$TOKEN" && ./smart-agent-neo.mjs config set gateway.auth.token "$TOKEN"' 2>&1 | _neodock_filter_warnings

  echo "🔍 Verifying token was saved..."
  local saved_token
  saved_token=$(_neodock_compose exec smart-agent-neo-gateway \
    bash -c "./smart-agent-neo.mjs config get gateway.remote.token 2>/dev/null" 2>&1 | _neodock_filter_warnings | tr -d '\r\n' | head -c 64)

  if [[ "$saved_token" == "$token" ]]; then
    echo "✅ Token saved correctly!"
  else
    echo "⚠️  Token mismatch detected"
    echo "   Expected: ${token:0:20}..."
    echo "   Got: ${saved_token:0:20}..."
  fi

  echo "🔄 Restarting gateway..."
  _neodock_compose restart smart-agent-neo-gateway 2>&1 | _neodock_filter_warnings

  echo "⏳ Waiting for gateway to start..."
  sleep 5

  echo "✅ Configuration complete!"
  echo -e "   Try: $(_cmd neodock-devices)"
}

# Open dashboard in browser
neodock-dashboard() {
  _neodock_ensure_dir || return 1

  echo "🦞 Getting dashboard URL..."
  local output exit_status url
  output=$(_neodock_compose run --rm smart-agent-neo-cli dashboard --no-open 2>&1)
  exit_status=$?
  url=$(printf "%s\n" "$output" | _neodock_filter_warnings | grep -o 'http[s]\?://[^[:space:]]*' | head -n 1)
  if [[ $exit_status -ne 0 ]]; then
    echo "❌ Failed to get dashboard URL"
    echo -e "   Try restarting: $(_cmd neodock-restart)"
    return 1
  fi

  if [[ -n "$url" ]]; then
    echo "✅ Opening: $url"
    open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || echo "   Please open manually: $url"
    echo ""
    echo -e "${_CLR_CYAN}💡 If you see 'pairing required' error:${_CLR_RESET}"
    echo -e "   1. Run: $(_cmd neodock-devices)"
    echo "   2. Copy the Request ID from the Pending table"
    echo -e "   3. Run: $(_cmd 'neodock-approve <request-id>')"
  else
    echo "❌ Failed to get dashboard URL"
    echo -e "   Try restarting: $(_cmd neodock-restart)"
  fi
}

# List device pairings
neodock-devices() {
  _neodock_ensure_dir || return 1

  echo "🔍 Checking device pairings..."
  local output exit_status
  output=$(_neodock_compose exec smart-agent-neo-gateway node dist/index.js devices list 2>&1)
  exit_status=$?
  printf "%s\n" "$output" | _neodock_filter_warnings
  if [ $exit_status -ne 0 ]; then
    echo ""
    echo -e "${_CLR_CYAN}💡 If you see token errors above:${_CLR_RESET}"
    echo -e "   1. Verify token is set: $(_cmd neodock-token)"
    echo "   2. Try manual config inside container:"
    echo -e "      $(_cmd neodock-shell)"
    echo -e "      $(_cmd 'smart-agent-neo config get gateway.remote.token')"
    return 1
  fi

  echo ""
  echo -e "${_CLR_CYAN}💡 To approve a pairing request:${_CLR_RESET}"
  echo -e "   $(_cmd 'neodock-approve <request-id>')"
}

# Approve device pairing request
neodock-approve() {
  _neodock_ensure_dir || return 1

  if [[ -z "$1" ]]; then
    echo -e "❌ Usage: $(_cmd 'neodock-approve <request-id>')"
    echo ""
    echo -e "${_CLR_CYAN}💡 How to approve a device:${_CLR_RESET}"
    echo -e "   1. Run: $(_cmd neodock-devices)"
    echo "   2. Find the Request ID in the Pending table (long UUID)"
    echo -e "   3. Run: $(_cmd 'neodock-approve <that-request-id>')"
    echo ""
    echo "Example:"
    echo -e "   $(_cmd 'neodock-approve 6f9db1bd-a1cc-4d3f-b643-2c195262464e')"
    return 1
  fi

  echo "✅ Approving device: $1"
  _neodock_compose exec smart-agent-neo-gateway \
    node dist/index.js devices approve "$1" 2>&1 | _neodock_filter_warnings

  echo ""
  echo "✅ Device approved! Refresh your browser."
}

# Show all available neodock helper commands
neodock-help() {
  echo -e "\n${_CLR_BOLD}${_CLR_CYAN}🦞 NeoDock - Docker Helpers for SmartAgentNeo${_CLR_RESET}\n"

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}⚡ Basic Operations${_CLR_RESET}"
  echo -e "  $(_cmd neodock-start)       ${_CLR_DIM}Start the gateway${_CLR_RESET}"
  echo -e "  $(_cmd neodock-stop)        ${_CLR_DIM}Stop the gateway${_CLR_RESET}"
  echo -e "  $(_cmd neodock-restart)     ${_CLR_DIM}Restart the gateway${_CLR_RESET}"
  echo -e "  $(_cmd neodock-status)      ${_CLR_DIM}Check container status${_CLR_RESET}"
  echo -e "  $(_cmd neodock-logs)        ${_CLR_DIM}View live logs (follows)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🐚 Container Access${_CLR_RESET}"
  echo -e "  $(_cmd neodock-shell)       ${_CLR_DIM}Shell into container (smart-agent-neo alias ready)${_CLR_RESET}"
  echo -e "  $(_cmd neodock-cli)         ${_CLR_DIM}Run CLI commands (e.g., neodock-cli status)${_CLR_RESET}"
  echo -e "  $(_cmd neodock-exec) ${_CLR_CYAN}<cmd>${_CLR_RESET}  ${_CLR_DIM}Execute command in gateway container${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🌐 Web UI & Devices${_CLR_RESET}"
  echo -e "  $(_cmd neodock-dashboard)   ${_CLR_DIM}Open web UI in browser ${_CLR_CYAN}(auto-guides you)${_CLR_RESET}"
  echo -e "  $(_cmd neodock-devices)     ${_CLR_DIM}List device pairings ${_CLR_CYAN}(auto-guides you)${_CLR_RESET}"
  echo -e "  $(_cmd neodock-approve) ${_CLR_CYAN}<id>${_CLR_RESET} ${_CLR_DIM}Approve device pairing ${_CLR_CYAN}(with examples)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}⚙️  Setup & Configuration${_CLR_RESET}"
  echo -e "  $(_cmd neodock-fix-token)   ${_CLR_DIM}Configure gateway token ${_CLR_CYAN}(run once)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🔧 Maintenance${_CLR_RESET}"
  echo -e "  $(_cmd neodock-rebuild)     ${_CLR_DIM}Rebuild Docker image${_CLR_RESET}"
  echo -e "  $(_cmd neodock-clean)       ${_CLR_RED}⚠️  Remove containers & volumes (nuclear)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🛠️  Utilities${_CLR_RESET}"
  echo -e "  $(_cmd neodock-health)      ${_CLR_DIM}Run health check${_CLR_RESET}"
  echo -e "  $(_cmd neodock-token)       ${_CLR_DIM}Show gateway auth token${_CLR_RESET}"
  echo -e "  $(_cmd neodock-cd)          ${_CLR_DIM}Jump to smart-agent-neo project directory${_CLR_RESET}"
  echo -e "  $(_cmd neodock-config)      ${_CLR_DIM}Open config directory (~/.smart-agent-neo)${_CLR_RESET}"
  echo -e "  $(_cmd neodock-workspace)   ${_CLR_DIM}Open workspace directory${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${_CLR_RESET}"
  echo -e "${_CLR_BOLD}${_CLR_GREEN}🚀 First Time Setup${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  1.${_CLR_RESET} $(_cmd neodock-start)          ${_CLR_DIM}# Start the gateway${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  2.${_CLR_RESET} $(_cmd neodock-fix-token)      ${_CLR_DIM}# Configure token${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  3.${_CLR_RESET} $(_cmd neodock-dashboard)      ${_CLR_DIM}# Open web UI${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  4.${_CLR_RESET} $(_cmd neodock-devices)        ${_CLR_DIM}# If pairing needed${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  5.${_CLR_RESET} $(_cmd neodock-approve) ${_CLR_CYAN}<id>${_CLR_RESET}   ${_CLR_DIM}# Approve pairing${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_GREEN}💬 WhatsApp Setup${_CLR_RESET}"
  echo -e "  $(_cmd neodock-shell)"
  echo -e "    ${_CLR_BLUE}>${_CLR_RESET} $(_cmd 'smart-agent-neo channels login --channel whatsapp')"
  echo -e "    ${_CLR_BLUE}>${_CLR_RESET} $(_cmd 'smart-agent-neo status')"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_CYAN}💡 All commands guide you through next steps!${_CLR_RESET}"
  echo -e "${_CLR_BLUE}📚 Docs: ${_CLR_RESET}${_CLR_CYAN}https://docs.smart-agent-neo.ai${_CLR_RESET}"
  echo ""
}
