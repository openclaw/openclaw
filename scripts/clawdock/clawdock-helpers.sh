#!/usr/bin/env bash
# ClawDock - Docker helpers for OpenClaw
# Inspired by Simon Willison's "Running OpenClaw in Docker"
# https://til.simonwillison.net/llms/openclaw-docker
#
# Installation:
#   mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawdock/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
#   echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc
#
# Usage:
#   clawdock-help    # Show all available commands

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
CLAWDOCK_CONFIG="${HOME}/.clawdock/config"

# Common paths to check for OpenClaw
CLAWDOCK_COMMON_PATHS=(
  "${HOME}/openclaw"
  "${HOME}/workspace/openclaw"
  "${HOME}/projects/openclaw"
  "${HOME}/dev/openclaw"
  "${HOME}/code/openclaw"
  "${HOME}/src/openclaw"
)

_clawdock_filter_warnings() {
  grep -v "^WARN\|^time="
}

_clawdock_trim_quotes() {
  local value="$1"
  value="${value#\"}"
  value="${value%\"}"
  printf "%s" "$value"
}

_clawdock_read_config_dir() {
  if [[ ! -f "$CLAWDOCK_CONFIG" ]]; then
    return 1
  fi
  local raw
  raw=$(sed -n 's/^CLAWDOCK_DIR=//p' "$CLAWDOCK_CONFIG" | head -n 1)
  if [[ -z "$raw" ]]; then
    return 1
  fi
  _clawdock_trim_quotes "$raw"
}

# Ensure CLAWDOCK_DIR is set and valid
_clawdock_ensure_dir() {
  # Already set and valid?
  if [[ -n "$CLAWDOCK_DIR" && -f "${CLAWDOCK_DIR}/docker-compose.yml" ]]; then
    return 0
  fi

  # Try loading from config
  local config_dir
  config_dir=$(_clawdock_read_config_dir)
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
    echo "🦞 Found OpenClaw at: $found_path"
    echo -n "   Use this location? [Y/n] "
    read -r response
    if [[ "$response" =~ ^[Nn] ]]; then
      echo ""
      echo "Set CLAWDOCK_DIR manually:"
      echo "  export CLAWDOCK_DIR=/path/to/openclaw"
      return 1
    fi
    CLAWDOCK_DIR="$found_path"
  else
    echo ""
    echo "❌ OpenClaw not found in common locations."
    echo ""
    echo "Clone it first:"
    echo ""
    echo "  git clone https://github.com/openclaw/openclaw.git ~/openclaw"
    echo "  cd ~/openclaw && ./docker-setup.sh"
    echo ""
    echo "Or set CLAWDOCK_DIR if it's elsewhere:"
    echo ""
    echo "  export CLAWDOCK_DIR=/path/to/openclaw"
    echo ""
    return 1
  fi

  # Save to config
  if [[ ! -d "${HOME}/.clawdock" ]]; then
    /bin/mkdir -p "${HOME}/.clawdock"
  fi
  echo "CLAWDOCK_DIR=\"$CLAWDOCK_DIR\"" > "$CLAWDOCK_CONFIG"
  echo "✅ Saved to $CLAWDOCK_CONFIG"
  echo ""
  return 0
}

# Wrapper to run docker compose commands
_clawdock_compose() {
  _clawdock_ensure_dir || return 1
  local compose_args=(-f "${CLAWDOCK_DIR}/docker-compose.yml")
  if [[ -f "${CLAWDOCK_DIR}/docker-compose.extra.yml" ]]; then
    compose_args+=(-f "${CLAWDOCK_DIR}/docker-compose.extra.yml")
  fi
  command docker compose "${compose_args[@]}" "$@"
}

_clawdock_read_env_token() {
  _clawdock_ensure_dir || return 1
  if [[ ! -f "${CLAWDOCK_DIR}/.env" ]]; then
    return 1
  fi
  local raw
  raw=$(sed -n 's/^OPENCLAW_GATEWAY_TOKEN=//p' "${CLAWDOCK_DIR}/.env" | head -n 1)
  if [[ -z "$raw" ]]; then
    return 1
  fi
  _clawdock_trim_quotes "$raw"
}

_clawdock_read_env_image() {
  _clawdock_ensure_dir || return 1
  if [[ ! -f "${CLAWDOCK_DIR}/.env" ]]; then
    echo "openclaw:local"
    return 0
  fi
  local raw
  raw=$(sed -n 's/^OPENCLAW_IMAGE=//p' "${CLAWDOCK_DIR}/.env" | head -n 1)
  if [[ -z "$raw" ]]; then
    echo "openclaw:local"
    return 0
  fi
  _clawdock_trim_quotes "$raw"
}

# Build the Docker image directly (compose file has no build: directive)
_clawdock_docker_build() {
  _clawdock_ensure_dir || return 1
  local image_name
  image_name=$(_clawdock_read_env_image)
  local apt_packages=""
  local install_browser=""
  if [[ -f "${CLAWDOCK_DIR}/.env" ]]; then
    local raw_apt
    raw_apt=$(sed -n 's/^OPENCLAW_DOCKER_APT_PACKAGES=//p' "${CLAWDOCK_DIR}/.env" | head -n 1)
    apt_packages=$(_clawdock_trim_quotes "$raw_apt")
    local raw_browser
    raw_browser=$(sed -n 's/^OPENCLAW_INSTALL_BROWSER=//p' "${CLAWDOCK_DIR}/.env" | head -n 1)
    install_browser=$(_clawdock_trim_quotes "$raw_browser")
  fi
  echo "🔨 Building Docker image: ${image_name} ..."
  local build_args=(
    --build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${apt_packages}"
  )
  if [[ -n "$install_browser" ]]; then
    build_args+=(--build-arg "OPENCLAW_INSTALL_BROWSER=${install_browser}")
  fi
  docker build \
    "${build_args[@]}" \
    -t "$image_name" \
    -f "${CLAWDOCK_DIR}/Dockerfile" \
    "${CLAWDOCK_DIR}"
}

# Basic Operations
clawdock-start() {
  _clawdock_compose up -d openclaw-gateway
}

clawdock-stop() {
  _clawdock_compose down
}

clawdock-restart() {
  _clawdock_compose restart openclaw-gateway
}

clawdock-logs() {
  _clawdock_compose logs -f openclaw-gateway
}

clawdock-status() {
  _clawdock_compose ps
}

clawdock-config() {
  local config_dir="${HOME}/.openclaw"
  echo -e "\n${_CLR_BOLD}${_CLR_CYAN}📦 OpenClaw Configuration${_CLR_RESET}\n"

  echo -e "${_CLR_BOLD}Config directory:${_CLR_RESET} ${_CLR_CYAN}${config_dir}${_CLR_RESET}"
  echo ""

  # Show openclaw.json
  if [[ -f "${config_dir}/openclaw.json" ]]; then
    echo -e "${_CLR_BOLD}${config_dir}/openclaw.json${_CLR_RESET}"
    echo -e "${_CLR_DIM}$(cat "${config_dir}/openclaw.json")${_CLR_RESET}"
  else
    echo -e "${_CLR_YELLOW}No openclaw.json found${_CLR_RESET}"
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
        echo -e "${_CLR_CYAN}${key}${_CLR_RESET}=${_CLR_DIM}${val:0:8}...${_CLR_RESET}"
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
        echo -e "${_CLR_CYAN}${key}${_CLR_RESET}=${_CLR_DIM}${val:0:8}...${_CLR_RESET}"
      else
        echo -e "${_CLR_DIM}${line}${_CLR_RESET}"
      fi
    done < "${CLAWDOCK_DIR}/.env"
  fi
  echo ""
}

# Container Access
clawdock-shell() {
  _clawdock_compose exec openclaw-gateway \
    bash -c 'echo "alias openclaw=\"./openclaw.mjs\"" > /tmp/.bashrc_openclaw && bash --rcfile /tmp/.bashrc_openclaw'
}

clawdock-exec() {
  _clawdock_compose exec openclaw-gateway "$@"
}

clawdock-cli() {
  _clawdock_compose run --rm openclaw-cli "$@"
}

# Maintenance
clawdock-update() {
  _clawdock_ensure_dir || return 1

  echo "🔄 Updating OpenClaw..."

  echo ""
  echo "📥 Pulling latest source..."
  git -C "${CLAWDOCK_DIR}" pull || { echo "❌ git pull failed"; return 1; }

  echo ""
  _clawdock_docker_build || { echo "❌ Build failed"; return 1; }

  echo ""
  echo "♻️  Recreating container with new image..."
  _clawdock_compose down 2>&1 | _clawdock_filter_warnings
  _clawdock_compose up -d openclaw-gateway 2>&1 | _clawdock_filter_warnings

  echo ""
  echo "⏳ Waiting for gateway to start..."
  local attempts=0
  local max_attempts=12
  while (( attempts < max_attempts )); do
    if _clawdock_compose exec openclaw-gateway node dist/index.js health &>/dev/null; then
      echo "✅ Update complete!"
      echo -e "   Verify: $(_cmd clawdock-cli status)"
      return 0
    fi
    sleep 2
    (( attempts++ ))
  done
  echo "⚠️  Gateway did not respond after ${max_attempts} attempts"
  echo -e "   Check logs: $(_cmd clawdock-logs)"
}

clawdock-rebuild() {
  _clawdock_docker_build
}

clawdock-clean() {
  _clawdock_compose down -v --remove-orphans
}

# Health check
clawdock-health() {
  _clawdock_ensure_dir || return 1
  local token
  token=$(_clawdock_read_env_token)
  if [[ -z "$token" ]]; then
    echo "❌ Error: Could not find gateway token"
    echo "   Check: ${CLAWDOCK_DIR}/.env"
    return 1
  fi
  _clawdock_compose exec -e "OPENCLAW_GATEWAY_TOKEN=$token" openclaw-gateway \
    node dist/index.js health
}

# Show gateway token
clawdock-token() {
  _clawdock_read_env_token
}

# Fix token configuration (run this once after setup)
clawdock-fix-token() {
  _clawdock_ensure_dir || return 1

  echo "🔧 Configuring gateway token..."
  local token
  token=$(clawdock-token)
  if [[ -z "$token" ]]; then
    echo "❌ Error: Could not find gateway token"
    echo "   Check: ${CLAWDOCK_DIR}/.env"
    return 1
  fi

  echo "📝 Setting token: ${token:0:20}..."

  _clawdock_compose exec -e "TOKEN=$token" openclaw-gateway \
    bash -c './openclaw.mjs config set gateway.remote.token "$TOKEN" && ./openclaw.mjs config set gateway.auth.token "$TOKEN"' 2>&1 | _clawdock_filter_warnings

  echo "🔍 Verifying token was saved..."
  local saved_token
  saved_token=$(_clawdock_compose exec openclaw-gateway \
    bash -c "./openclaw.mjs config get gateway.remote.token 2>/dev/null" 2>&1 | _clawdock_filter_warnings | tr -d '\r\n' | head -c 64)

  if [[ "$saved_token" == "$token" ]]; then
    echo "✅ Token saved correctly!"
  else
    echo "⚠️  Token mismatch detected"
    echo "   Expected: ${token:0:20}..."
    echo "   Got: ${saved_token:0:20}..."
  fi

  echo "🔄 Restarting gateway..."
  _clawdock_compose restart openclaw-gateway 2>&1 | _clawdock_filter_warnings

  echo "⏳ Waiting for gateway to start..."
  local attempts=0
  local max_attempts=12
  while (( attempts < max_attempts )); do
    if _clawdock_compose exec openclaw-gateway node dist/index.js health &>/dev/null; then
      echo "✅ Configuration complete!"
      echo -e "   Try: $(_cmd clawdock-devices)"
      return 0
    fi
    sleep 2
    (( attempts++ ))
  done
  echo "⚠️  Gateway did not respond after ${max_attempts} attempts"
  echo -e "   Check logs: $(_cmd clawdock-logs)"
}

# Open dashboard in browser
clawdock-dashboard() {
  _clawdock_ensure_dir || return 1

  echo "🦞 Getting dashboard URL..."
  local output exit_status url
  output=$(_clawdock_compose run --rm openclaw-cli dashboard --no-open 2>&1)
  exit_status=$?
  url=$(printf "%s\n" "$output" | _clawdock_filter_warnings | grep -o 'http[s]\?://[^[:space:]]*' | head -n 1)
  if [[ $exit_status -ne 0 ]]; then
    echo "❌ Failed to get dashboard URL"
    echo -e "   Try restarting: $(_cmd clawdock-restart)"
    return 1
  fi

  if [[ -n "$url" ]]; then
    echo -e "✅ Opening: ${_CLR_CYAN}${url}${_CLR_RESET}"
    open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || echo -e "   Please open manually: ${_CLR_CYAN}${url}${_CLR_RESET}"
    echo ""
    echo -e "${_CLR_CYAN}💡 If you see ${_CLR_RED}'pairing required'${_CLR_CYAN} error:${_CLR_RESET}"
    echo -e "   1. Run: $(_cmd clawdock-devices)"
    echo "   2. Copy the Request ID from the Pending table"
    echo -e "   3. Run: $(_cmd 'clawdock-approve <request-id>')"
  else
    echo "❌ Failed to get dashboard URL"
    echo -e "   Try restarting: $(_cmd clawdock-restart)"
  fi
}

# List device pairings
clawdock-devices() {
  _clawdock_ensure_dir || return 1

  echo "🔍 Checking device pairings..."
  local output exit_status
  output=$(_clawdock_compose exec openclaw-gateway node dist/index.js devices list 2>&1)
  exit_status=$?
  printf "%s\n" "$output" | _clawdock_filter_warnings
  if [ $exit_status -ne 0 ]; then
    echo ""
    echo -e "${_CLR_CYAN}💡 If you see token errors above:${_CLR_RESET}"
    echo -e "   1. Verify token is set: $(_cmd clawdock-token)"
    echo -e "   2. Try fixing the token automatically: $(_cmd clawdock-fix-token)"
    echo "   3. If you still see errors, try manual config inside container:"
    echo -e "      $(_cmd clawdock-shell)"
    echo -e "      $(_cmd 'openclaw config get gateway.remote.token')"
    return 1
  fi

  echo ""
  echo -e "${_CLR_CYAN}💡 To approve a pairing request:${_CLR_RESET}"
  echo -e "   $(_cmd 'clawdock-approve <request-id>')"
}

# Approve device pairing request
clawdock-approve() {
  _clawdock_ensure_dir || return 1

  if [[ -z "$1" ]]; then
    echo -e "❌ Usage: $(_cmd 'clawdock-approve <request-id>')"
    echo ""
    echo -e "${_CLR_CYAN}💡 How to approve a device:${_CLR_RESET}"
    echo -e "   1. Run: $(_cmd clawdock-devices)"
    echo "   2. Find the Request ID in the Pending table (long UUID)"
    echo -e "   3. Run: $(_cmd 'clawdock-approve <that-request-id>')"
    echo ""
    echo "Example:"
    echo -e "   $(_cmd 'clawdock-approve 6f9db1bd-a1cc-4d3f-b643-2c195262464e')"
    return 1
  fi

  echo "✅ Approving device: $1"
  _clawdock_compose exec openclaw-gateway \
    node dist/index.js devices approve "$1" 2>&1 | _clawdock_filter_warnings

  echo ""
  echo "✅ Device approved! Refresh your browser."
}

# Show all available clawdock helper commands
clawdock-help() {
  echo -e "\n${_CLR_BOLD}${_CLR_CYAN}🦞 ClawDock - Docker Helpers for OpenClaw${_CLR_RESET}\n"

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}⚡ Basic Docker Operations${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-start)       ${_CLR_DIM}Start the docker container${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-stop)        ${_CLR_DIM}Stop the docker container${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-restart)     ${_CLR_DIM}Restart the docker container${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-status)      ${_CLR_DIM}Check docker container status${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-logs)        ${_CLR_DIM}View docker container logs (follows)${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-health)      ${_CLR_DIM}Run docker container health check${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🐚 Docker Container Access${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-shell)       ${_CLR_DIM}Shell into docker container (openclaw alias ready)${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-cli)         ${_CLR_DIM}Run CLI in docker container (e.g., clawdock-cli status)${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-exec) ${_CLR_CYAN}<cmd>${_CLR_RESET}  ${_CLR_DIM}Execute command in docker container${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🌐 Web UI & Devices${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-dashboard)   ${_CLR_DIM}Open web UI in browser ${_CLR_CYAN}(auto-guides you)${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-devices)     ${_CLR_DIM}List device pairings ${_CLR_CYAN}(auto-guides you)${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-approve) ${_CLR_CYAN}<id>${_CLR_RESET} ${_CLR_DIM}Approve device pairing ${_CLR_CYAN}(with examples)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}⚙️  Setup & Configuration${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-fix-token)   ${_CLR_DIM}Configure gateway token ${_CLR_CYAN}(run once)${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-token)       ${_CLR_DIM}Show gateway auth token${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}📦 Configuration${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-config)            ${_CLR_DIM}Show all config files (masked secrets)${_CLR_RESET}"
  echo -e "  ${_CLR_CYAN}~/.openclaw/.env${_CLR_RESET}           ${_CLR_DIM}Secrets (API keys, bot tokens)${_CLR_RESET}"
  echo -e "  ${_CLR_CYAN}~/.openclaw/openclaw.json${_CLR_RESET}  ${_CLR_DIM}Behavior (models, channels, policies)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_MAGENTA}🔧 Maintenance${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-update)      ${_CLR_DIM}Pull, rebuild, and restart docker container ${_CLR_CYAN}(one-command update)${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-rebuild)     ${_CLR_DIM}Rebuild Docker image only${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-clean)       ${_CLR_RED}⚠️  Remove docker containers & volumes (nuclear)${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${_CLR_RESET}"
  echo -e "${_CLR_BOLD}${_CLR_GREEN}🚀 First Time Setup${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  1.${_CLR_RESET} $(_cmd clawdock-start)          ${_CLR_DIM}# Start the docker container${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  2.${_CLR_RESET} $(_cmd clawdock-fix-token)      ${_CLR_DIM}# Configure token${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  3.${_CLR_RESET} $(_cmd 'clawdock-cli onboard')    ${_CLR_DIM}# Configure API keys & channels${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  4.${_CLR_RESET} $(_cmd clawdock-dashboard)      ${_CLR_DIM}# Open web UI${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  5.${_CLR_RESET} $(_cmd clawdock-devices)        ${_CLR_DIM}# If pairing needed${_CLR_RESET}"
  echo -e "${_CLR_CYAN}  6.${_CLR_RESET} $(_cmd clawdock-approve) ${_CLR_CYAN}<id>${_CLR_RESET}   ${_CLR_DIM}# Approve pairing${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_GREEN}💬 WhatsApp Setup${_CLR_RESET}"
  echo -e "  $(_cmd clawdock-shell)"
  echo -e "    ${_CLR_BLUE}>${_CLR_RESET} $(_cmd 'openclaw channels login --channel whatsapp')"
  echo -e "    ${_CLR_BLUE}>${_CLR_RESET} $(_cmd 'openclaw status')"
  echo ""

  echo -e "${_CLR_BOLD}${_CLR_CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${_CLR_RESET}"
  echo ""

  echo -e "${_CLR_CYAN}💡 All commands guide you through next steps!${_CLR_RESET}"
  echo -e "${_CLR_BLUE}📚 Docs: ${_CLR_RESET}${_CLR_CYAN}https://docs.openclaw.ai${_CLR_RESET}"
  echo ""
}
