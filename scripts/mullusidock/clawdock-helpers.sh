#!/usr/bin/env bash
# ClawDock - Docker helpers for Mullusi
# Inspired by Simon Willison's "Running Mullusi in Docker"
# https://til.simonwillison.net/llms/mullusi-docker
#
# Installation:
#   mkdir -p ~/.mullusiock && curl -sL https://raw.githubusercontent.com/mullusi/mullusi/main/scripts/mullusiock/mullusiock-helpers.sh -o ~/.mullusiock/mullusiock-helpers.sh
#   echo 'source ~/.mullusiock/mullusiock-helpers.sh' >> ~/.zshrc
#
# Usage:
#   mullusiock-help    # Show all available commands

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
CLAWDOCK_CONFIG="${HOME}/.mullusiock/config"

# Common paths to check for Mullusi
CLAWDOCK_COMMON_PATHS=(
  "${HOME}/mullusi"
  "${HOME}/workspace/mullusi"
  "${HOME}/projects/mullusi"
  "${HOME}/dev/mullusi"
  "${HOME}/code/mullusi"
  "${HOME}/src/mullusi"
)

_mullusiock_filter_warnings() {
  grep -v "^WARN\|^time="
}

_mullusiock_trim_quotes() {
  local value="$1"
  value="${value#\"}"
  value="${value%\"}"
  printf "%s" "$value"
}

_mullusiock_mask_value() {
  local value="$1"
  local length=${#value}
  if (( length == 0 )); then
    printf "%s" "<empty>"
    return 0
  fi
  if (( length == 1 )); then
    printf "%s" "<redacted:1 char>"
    return 0
  fi
  printf "%s" "<redacted:${length} chars>"
}

_mullusiock_read_config_dir() {
  if [[ ! -f "$CLAWDOCK_CONFIG" ]]; then
    return 1
  fi
  local raw
  raw=$(sed -n 's/^CLAWDOCK_DIR=//p' "$CLAWDOCK_CONFIG" | head -n 1)
  if [[ -z "$raw" ]]; then
    return 1
  fi
  _mullusiock_trim_quotes "$raw"
}

# Ensure CLAWDOCK_DIR is set and valid
_mullusiock_ensure_dir() {
  # Already set and valid?
  if [[ -n "$CLAWDOCK_DIR" && -f "${CLAWDOCK_DIR}/docker-compose.yml" ]]; then
    return 0
  fi

  # Try loading from config
  local config_dir
  config_dir=$(_mullusiock_read_config_dir)
  if [[ -n "$config_dir" && -f "${config_dir}/docker-compose.yml" ]]; then
    CLAWDOCK_DIR="$config_dir"
    return 0
  fi

  # Auto-detect from common paths
  local found_path=""
  for path in "${CLAWDOCK_COMMON_PATHS[@]}"; do
    if [[ -f "${path}/docker-compose.yml" ]]; then
      found_path="$path"
      break
    fi
  done

  if [[ -n "$found_path" ]]; then
    echo ""
    echo "🦞 Found Mullusi at: $found_path"
    echo -n "   Use this location? [Y/n] "
    read -r response
    if [[ "$response" =~ ^[Nn] ]]; then
      echo ""
      echo "Set CLAWDOCK_DIR manually:"
      echo "  export CLAWDOCK_DIR=/path/to/mullusi"
      return 1
    fi
    CLAWDOCK_DIR="$found_path"
  else
    echo ""
    echo "❌ Mullusi not found in common locations."
    echo ""
    echo "Clone it first:"
    echo ""
    echo "  git clone https://github.com/mullusi/mullusi.git ~/mullusi"
    echo "  cd ~/mullusi && ./scripts/docker/setup.sh"
    echo ""
    echo "Or set CLAWDOCK_DIR if it's elsewhere:"
    echo ""
    echo "  export CLAWDOCK_DIR=/path/to/mullusi"
    echo ""
    return 1
  fi

  # Save to config
  if [[ ! -d "${HOME}/.mullusiock" ]]; then
    /bin/mkdir -p "${HOME}/.mullusiock"
  fi
  echo "CLAWDOCK_DIR=\"$CLAWDOCK_DIR\"" > "$CLAWDOCK_CONFIG"
  echo "✅ Saved to $CLAWDOCK_CONFIG"
  echo ""
  return 0
}

# Wrapper to run docker compose commands
_mullusiock_compose() {
  _mullusiock_ensure_dir || return 1
  local compose_args=(-f "${CLAWDOCK_DIR}/docker-compose.yml")
  if [[ -f "${CLAWDOCK_DIR}/docker-compose.extra.yml" ]]; then
    compose_args+=(-f "${CLAWDOCK_DIR}/docker-compose.extra.yml")
  fi
  command docker compose "${compose_args[@]}" "$@"
}

_mullusiock_read_env_token() {
  _mullusiock_ensure_dir || return 1
  if [[ ! -f "${CLAWDOCK_DIR}/.env" ]]; then
    return 1
  fi
  local raw
  raw=$(sed -n 's/^MULLUSI_GATEWAY_TOKEN=//p' "${CLAWDOCK_DIR}/.env" | head -n 1)
  if [[ -z "$raw" ]]; then
    return 1
  fi
  _mullusiock_trim_quotes "$raw"
}

# Basic Operations
mullusiock-start() {
  _mullusiock_compose up -d mullusi-gateway
}

mullusiock-stop() {
  _mullusiock_compose down
}

mullusiock-restart() {
  _mullusiock_compose restart mullusi-gateway
}

mullusiock-logs() {
  _mullusiock_compose logs -f mullusi-gateway
}

mullusiock-status() {
  _mullusiock_compose ps
}

# Navigation
mullusiock-cd() {
  _mullusiock_ensure_dir || return 1
  cd "${CLAWDOCK_DIR}"
}

mullusiock-config() {
  cd ~/.mullusi
}

mullusiock-show-config() {
  _mullusiock_ensure_dir >/dev/null 2>&1 || true
  local config_dir="${HOME}/.mullusi"
  echo -e "${_CLR_BOLD}Config directory:${_CLR_RESET} ${_CLR_CYAN}${config_dir}${_CLR_RESET}"
  echo ""

  # Show mullusi.json
  if [[ -f "${config_dir}/mullusi.json" ]]; then
    echo -e "${_CLR_BOLD}${config_dir}/mullusi.json${_CLR_RESET}"
    echo -e "${_CLR_DIM}$(cat "${config_dir}/mullusi.json")${_CLR_RESET}"
  else
    echo -e "${_CLR_YELLOW}No mullusi.json found${_CLR_RESET}"
  fi
  echo ""

  # Show .env (mask secret values)
  if [[ -f "${config_dir}/.env" ]]; then
    echo -e "${_CLR_BOLD}${config_dir}/.env${_CLR_RESET}"
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "$line" ]]; then
        echo -e "${_CLR_DIM}${line}${_CLR_RESET}"
      elif [[ "$line" == *=* ]]; then
        local key="${line%%=*}"
        local val="${line#*=}"
        echo -e "${_CLR_CYAN}${key}${_CLR_RESET}=${_CLR_DIM}$(_mullusiock_mask_value "$val")${_CLR_RESET}"
      else
        echo -e "${_CLR_DIM}${line}${_CLR_RESET}"
      fi
    done < "${config_dir}/.env"
  else
    echo -e "${_CLR_YELLOW}No .env found${_CLR_RESET}"
  fi
  echo ""

  # Show project .env if available
  if [[ -n "$CLAWDOCK_DIR" && -f "${CLAWDOCK_DIR}/.env" ]]; then
    echo -e "${_CLR_BOLD}${CLAWDOCK_DIR}/.env${_CLR_RESET}"
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "$line" ]]; then
        echo -e "${_CLR_DIM}${line}${_CLR_RESET}"
      elif [[ "$line" == *=* ]]; then
        local key="${line%%=*}"
        local val="${line#*=}"
        echo -e "${_CLR_CYAN}${key}${_CLR_RESET}=${_CLR_DIM}$(_mullusiock_mask_value "$val")${_CLR_RESET}"
      else
        echo -e "${_CLR_DIM}${line}${_CLR_RESET}"
      fi
    done < "${CLAWDOCK_DIR}/.env"
  fi
  echo ""
}

mullusiock-workspace() {
  cd ~/.mullusi/workspace
}

# Container Access
mullusiock-shell() {
  _mullusiock_compose exec mullusi-gateway \
    bash -c 'echo "alias mullusi=\"./mullusi.mjs\"" > /tmp/.bashrc_mullusi && bash --rcfile /tmp/.bashrc_mullusi'
}

mullusiock-exec() {
  _mullusiock_compose exec mullusi-gateway "$@"
}

mullusiock-cli() {
  _mullusiock_compose run --rm mullusi-cli "$@"
}

# Maintenance
mullusiock-update() {
  _mullusiock_ensure_dir || return 1

  echo "🔄 Updating Mullusi..."

  echo ""
  echo "📥 Pulling latest source..."
  git -C "${CLAWDOCK_DIR}" pull || { echo "❌ git pull failed"; return 1; }

  echo ""
  echo "🔨 Rebuilding Docker image (this may take a few minutes)..."
  _mullusiock_compose build mullusi-gateway || { echo "❌ Build failed"; return 1; }

  echo ""
  echo "♻️  Recreating container with new image..."
  _mullusiock_compose down 2>&1 | _mullusiock_filter_warnings
  _mullusiock_compose up -d mullusi-gateway 2>&1 | _mullusiock_filter_warnings

  echo ""
  echo "⏳ Waiting for gateway to start..."
  sleep 5

  echo "✅ Update complete!"
  echo -e "   Verify: $(_cmd mullusiock-cli status)"
}

mullusiock-rebuild() {
  _mullusiock_compose build mullusi-gateway
}

mullusiock-clean() {
  _mullusiock_compose down -v --remove-orphans
}

# Health check
mullusiock-health() {
  _mullusiock_ensure_dir || return 1
  local token
  token=$(_mullusiock_read_env_token)
  if [[ -z "$token" ]]; then
    echo "❌ Error: Could not find gateway token"
    echo "   Check: ${CLAWDOCK_DIR}/.env"
    return 1
  fi
  _mullusiock_compose exec -e "MULLUSI_GATEWAY_TOKEN=$token" mullusi-gateway \
    node dist/index.js health
}

# Show gateway token
mullusiock-token() {
  _mullusiock_read_env_token
}

# Fix token configuration (run this once after setup)
mullusiock-fix-token() {
  _mullusiock_ensure_dir || return 1

  echo "🔧 Configuring gateway token..."
  local token
  token=$(mullusiock-token)
  if [[ -z "$token" ]]; then
    echo "❌ Error: Could not find gateway token"
    echo "   Check: ${CLAWDOCK_DIR}/.env"
    return 1
  fi

  echo "📝 Setting token: ${token:0:20}..."

  _mullusiock_compose exec -e "TOKEN=$token" mullusi-gateway \
    bash -c './mullusi.mjs config set gateway.remote.token "$TOKEN" && ./mullusi.mjs config set gateway.auth.token "$TOKEN"' 2>&1 | _mullusiock_filter_warnings

  echo "🔍 Verifying token was saved..."
  local saved_token
  saved_token=$(_mullusiock_compose exec mullusi-gateway \
    bash -c "./mullusi.mjs config get gateway.remote.token 2>/dev/null" 2>&1 | _mullusiock_filter_warnings | tr -d '\r\n' | head -c 64)

  if [[ "$saved_token" == "$token" ]]; then
    echo "✅ Token saved correctly!"
  else
    echo "⚠️  Token mismatch detected"
    echo "   Expected: ${token:0:20}..."
    echo "   Got: ${saved_token:0:20}..."
  fi

  echo "🔄 Restarting gateway..."
  _mullusiock_compose restart mullusi-gateway 2>&1 | _mullusiock_filter_warnings

  echo "⏳ Waiting for gateway to start..."
  sleep 5

  echo "✅ Configuration complete!"
  echo -e "   Try: $(_cmd mullusiock-devices)"
}

# Open dashboard in browser
mullusiock-dashboard() {
  _mullusiock_ensure_dir || return 1

  echo "🦞 Getting dashboard URL..."
  local output exit_status url
  output=$(_mullusiock_compose run --rm mullusi-cli dashboard --no-open 2>&1)
  exit_status=$?
  url=$(printf "%s\n" "$output" | _mullusiock_filter_warnings | grep -o 'http[s]\?://[^[:space:]]*' | head -n 1)
  if [[ $exit_status -ne 0 ]]; then
    echo "❌ Failed to get dashboard URL"
    echo -e "   Try restarting: $(_cmd mullusiock-restart)"
    return 1
  fi

  if [[ -n "$url" ]]; then
    echo -e "✅ Opening: ${_CLR_CYAN}${url}${_CLR_RESET}"
    open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || echo -e "   Please open manually: ${_CLR_CYAN}${url}${_CLR_RESET}"
    echo ""
    echo -e "${_CLR_CYAN}💡 If you see ${_CLR_RED}'pairing required'${_CLR_CYAN} error:${_CLR_RESET}"
    echo -e "   1. Run: $(_cmd mullusiock-devices)"
    echo "   2. Copy the Request ID from the Pending table"
    echo -e "   3. Run: $(_cmd 'mullusiock-approve <request-id>')"
  else
    echo "❌ Failed to get dashboard URL"
    echo -e "   Try restarting: $(_cmd mullusiock-restart)"
  fi
}

# List device pairings
mullusiock-devices() {
  _mullusiock_ensure_dir || return 1

  echo "🔍 Checking device pairings..."
  local output exit_status
  output=$(_mullusiock_compose exec mullusi-gateway node dist/index.js devices list 2>&1)
  exit_status=$?
  printf "%s\n" "$output" | _mullusiock_filter_warnings
  if [ $exit_status -ne 0 ]; then
    echo ""
    echo -e "${_CLR_CYAN}💡 If you see token errors above:${_CLR_RESET}"
    echo -e "   1. Verify token is set: $(_cmd mullusiock-token)"
    echo -e "   2. Try fixing the token automatically: $(_cmd mullusiock-fix-token)"
    echo "   3. If you still see errors, try manual config inside container:"
    echo -e "      $(_cmd mullusiock-shell)"
    echo -e "      $(_cmd 'mullusi config get gateway.remote.token')"
    return 1
  fi

  echo ""
  echo -e "${_CLR_CYAN}💡 To approve a pairing request:${_CLR_RESET}"
  echo -e "   $(_cmd 'mullusiock-approve <request-id>')"
}

# Approve device pairing request
mullusiock-approve() {
  _mullusiock_ensure_dir || return 1

  if [[ -z "$1" ]]; then
    echo -e "❌ Usage: $(_cmd 'mullusiock-approve <request-id>')"
    echo ""
    echo -e "${_CLR_CYAN}💡 How to approve a device:${_CLR_RESET}"
    echo -e "   1. Run: $(_cmd mullusiock-devices)"
    echo "   2. Find the Request ID in the Pending table (long UUID)"
    echo -e "   3. Run: $(_cmd 'mullusiock-approve <that-request-id>')"
    echo ""
    echo "Example:"
    echo -e "   $(_cmd 'mullusiock-approve 6f9db1bd-a1cc-4d3f-b643-2c195262464e')"
    return 1
  fi

  echo "✅ Approving device: $1"
  _mullusiock_compose exec mullusi-gateway \
    node dist/index.js devices approve "$1" 2>&1 | _mullusiock_filter_warnings

  echo ""
  echo "✅ Device approved! Refresh your browser."
}

# Show all available mullusiock helper commands
mullusiock-help() {
  echo -e "\n${_CLR_BOLD}${_CLR_CYAN}🦞 ClawDock - Docker Helpers for Mullusi${_CLR_RESET}\n"

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}⚡ Basic Operations${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-start)       ${_CLR_DIM}Start the gateway${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-stop)        ${_CLR_DIM}Stop the gateway${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-restart)     ${_CLR_DIM}Restart the gateway${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-status)      ${_CLR_DIM}Check container status${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-logs)        ${_CLR_DIM}View live logs (follows)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🐚 Container Access${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-shell)       ${_CLR_DIM}Shell into container (mullusi alias ready)${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-cli)         ${_CLR_DIM}Run CLI commands (e.g., mullusiock-cli status)${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-exec) ${_CLR_CYAN}<cmd>${_CLR_RESET}  ${_CLR_DIM}Execute command in gateway container${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🌐 Web UI & Devices${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-dashboard)   ${_CLR_DIM}Open web UI in browser ${_CLR_CYAN}(auto-guides you)${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-devices)     ${_CLR_DIM}List device pairings ${_CLR_CYAN}(auto-guides you)${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-approve) ${_CLR_CYAN}<id>${_CLR_RESET} ${_CLR_DIM}Approve device pairing ${_CLR_CYAN}(with examples)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}⚙️  Setup & Configuration${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-fix-token)   ${_CLR_DIM}Configure gateway token ${_CLR_CYAN}(run once)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🔧 Maintenance${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-update)      ${_CLR_DIM}Pull, rebuild, and restart ${_CLR_CYAN}(one-command update)${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-rebuild)     ${_CLR_DIM}Rebuild Docker image only${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-clean)       ${_CLR_RED}⚠️  Remove containers & volumes (nuclear)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🛠️  Utilities${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-health)      ${_CLR_DIM}Run health check${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-token)       ${_CLR_DIM}Show gateway auth token${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-cd)          ${_CLR_DIM}Jump to mullusi project directory${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-config)      ${_CLR_DIM}Open config directory (~/.mullusi)${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-show-config) ${_CLR_DIM}Print config files with redacted values${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-workspace)   ${_CLR_DIM}Open workspace directory${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${_CLR_RESET}"
  echo -e "${_CLR_BOLD}${_CLR_GREEN}🚀 First Time Setup${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  1.${_CLR_RESET} $(_cmd mullusiock-start)          ${_CLR_DIM}# Start the gateway${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  2.${_CLR_RESET} $(_cmd mullusiock-fix-token)      ${_CLR_DIM}# Configure token${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  3.${_CLR_RESET} $(_cmd mullusiock-dashboard)      ${_CLR_DIM}# Open web UI${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  4.${_CLR_RESET} $(_cmd mullusiock-devices)        ${_CLR_DIM}# If pairing needed${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  5.${_CLR_RESET} $(_cmd mullusiock-approve) ${_CLR_CYAN}<id>${_CLR_RESET}   ${_CLR_DIM}# Approve pairing${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_GREEN}💬 WhatsApp Setup${_CLR_RESET}"
  echo -e "  $(_cmd mullusiock-shell)"
  echo -e "    ${_CLR_BLUE}>${_CLR_RESET} $(_cmd 'mullusi channels login --channel whatsapp')"
  echo -e "    ${_CLR_BLUE}>${_CLR_RESET} $(_cmd 'mullusi status')"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_CYAN}💡 All commands guide you through next steps!${_CLR_RESET}"
  echo -e "${_CLR_BLUE}📚 Docs: ${_CLR_RESET}${_CLR_CYAN}https://docs.mullusi.com${_CLR_RESET}"
  echo ""
}
