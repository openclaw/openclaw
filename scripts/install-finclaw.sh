#!/bin/bash
set -euo pipefail

# OpenFinClaw Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
#
# Non-interactive usage:
#   OPENFINCLAW_PLUGINS=all ./install-finclaw.sh
#   OPENFINCLAW_PLUGINS=fin-core,fin-market-data ./install-finclaw.sh
#
# Repository: https://github.com/cryptoSUN2049/openFinclaw

BOLD='\033[1m'
ACCENT='\033[38;2;255;77;77m'
SUCCESS='\033[38;2;0;229;204m'
INFO='\033[38;2;136;146;176m'
WARN='\033[38;2;255;176;32m'
MUTED='\033[38;2;90;100;128m'
NC='\033[0m'

REPO_URL="https://github.com/cryptoSUN2049/openFinclaw"
HUB_URL="https://hub.openfinclaw.ai"

# Plugin definitions: id|name|npm package|description|is_required
PLUGIN_DEFS=(
  "fin-shared-types|Shared Types|@openfinclaw/fin-shared-types|Shared types and interfaces|true"
  "fin-core|Fin Core|@openfinclaw/fin-core|Core infrastructure, exchange registry|true"
  "fin-market-data|Market Data|@openfinclaw/fin-market-data|Prices, orderbooks, tickers|false"
  "fin-strategy-engine|Strategy Engine|@openfinclaw/fin-strategy-engine|Indicators, backtest, evolution|false"
  "fin-backtest-remote|Backtest Remote|@openfinclaw/fin-backtest-remote|Submit backtests to remote server|false"
  "openfinclaw|OpenFinClaw|@openfinclaw/openfinclaw|Skills: fin-strategy-builder|false"
)

# Installation order (dependencies first)
INSTALL_ORDER=("fin-shared-types" "fin-core" "fin-market-data" "fin-strategy-engine" "fin-backtest-remote" "openfinclaw")

# Parse plugin definition
get_plugin_field() {
  local id="$1"
  local field="$2"
  for def in "${PLUGIN_DEFS[@]}"; do
    if [[ "$def" == "$id|"* ]]; then
      echo "$def" | cut -d'|' -f"$field"
      return
    fi
  done
}

print_banner() {
  echo ""
  echo -e "${ACCENT}${BOLD}  🦞 OpenFinClaw Installer${NC}"
  echo -e "${INFO}  Financial tools suite for OpenClaw${NC}"
  echo -e "${MUTED}  Repository: ${REPO_URL}${NC}"
  echo ""
}

check_openclaw() {
  if ! command -v openclaw &>/dev/null; then
    echo -e "${WARN}OpenClaw is not installed.${NC}"
    echo ""
    echo "Installing OpenClaw first..."
    curl -fsSL https://openclaw.ai/install.sh | bash
    echo ""
  fi
  echo -e "${SUCCESS}✓${NC} OpenClaw is installed: $(openclaw --version 2>/dev/null | head -1 || echo 'unknown')"
}

select_plugins() {
  # Non-interactive mode via environment variable
  if [ -n "${OPENFINCLAW_PLUGINS:-}" ]; then
    if [ "$OPENFINCLAW_PLUGINS" = "all" ]; then
      SELECTED_PLUGINS=("${INSTALL_ORDER[@]}")
    else
      IFS=',' read -ra SELECTED_PLUGINS <<< "$OPENFINCLAW_PLUGINS"
    fi
    return
  fi

  # Check if interactive
  if [ ! -t 0 ]; then
    SELECTED_PLUGINS=("${INSTALL_ORDER[@]}")
    return
  fi

  # Use gum if available
  if command -v gum &>/dev/null; then
    select_with_gum
  else
    select_with_read
  fi
}

select_with_gum() {
  echo ""
  echo -e "${BOLD}Select plugins to install:${NC}"
  echo ""
  
  local options=()
  local selected=()
  
  for id in "${INSTALL_ORDER[@]}"; do
    local name=$(get_plugin_field "$id" 2)
    local desc=$(get_plugin_field "$id" 4)
    local required=$(get_plugin_field "$id" 5)
    
    if [ "$required" = "true" ]; then
      options+=("$name - $desc (required)")
    else
      options+=("$name - $desc")
    fi
  done
  
  # Show selection (default all selected)
  local chosen=$(gum choose --no-limit --selected="0,1,2,3,4,5" "${options[@]}")
  
  # Map back to plugin IDs
  local i=0
  for opt in "${options[@]}"; do
    local id="${INSTALL_ORDER[$i]}"
    if echo "$chosen" | grep -q "${options[$i]}"; then
      selected+=("$id")
    fi
    ((i++))
  done
  
  SELECTED_PLUGINS=("${selected[@]}")
}

select_with_read() {
  echo ""
  echo -e "${BOLD}Select plugins to install:${NC}"
  echo ""
  
  local all_selected=true
  SELECTED_PLUGINS=()
  
  for id in "${INSTALL_ORDER[@]}"; do
    local name=$(get_plugin_field "$id" 2)
    local desc=$(get_plugin_field "$id" 4)
    local required=$(get_plugin_field "$id" 5)
    
    if [ "$required" = "true" ]; then
      echo -e "  ${SUCCESS}✓${NC} $name - $desc ${MUTED}(required)${NC}"
      SELECTED_PLUGINS+=("$id")
    else
      echo -e "  [ ] $name - $desc"
    fi
  done
  
  echo ""
  echo "Enter plugins to install (comma-separated, e.g., fin-core,fin-market-data)"
  echo "Press Enter to install all [default]: "
  read -r input
  
  if [ -z "$input" ]; then
    SELECTED_PLUGINS=("${INSTALL_ORDER[@]}")
  else
    IFS=',' read -ra SELECTED_PLUGINS <<< "$input"
    # Always include required plugins
    for id in "${INSTALL_ORDER[@]}"; do
      local required=$(get_plugin_field "$id" 5)
      if [ "$required" = "true" ]; then
        if [[ ! " ${SELECTED_PLUGINS[*]} " =~ " ${id} " ]]; then
          SELECTED_PLUGINS=("$id" "${SELECTED_PLUGINS[@]}")
        fi
      fi
    done
  fi
}

install_plugins() {
  echo ""
  echo -e "${INFO}Installing selected plugins...${NC}"
  echo ""
  
  local failed=()
  local installed=()
  
  for id in "${INSTALL_ORDER[@]}"; do
    # Check if this plugin was selected
    local should_install=false
    for sel in "${SELECTED_PLUGINS[@]}"; do
      if [ "$sel" = "$id" ]; then
        should_install=true
        break
      fi
    done
    
    if [ "$should_install" = false ]; then
      continue
    fi
    
    local pkg=$(get_plugin_field "$id" 3)
    local name=$(get_plugin_field "$id" 2)
    
    echo -e "${MUTED}Installing $name ($pkg)...${NC}"
    
    if openclaw plugins install "$pkg" 2>&1 | grep -E "(successfully|already installed)" >/dev/null; then
      echo -e "  ${SUCCESS}✓${NC} $name installed"
      installed+=("$id")
    else
      echo -e "  ${WARN}✗${NC} $name failed"
      failed+=("$name")
    fi
  done
  
  echo ""
  
  if [ ${#failed[@]} -gt 0 ]; then
    echo -e "${WARN}Some plugins failed to install:${NC}"
    for f in "${failed[@]}"; do
      echo "  - $f"
    done
    echo ""
  fi
}

configure_api_key() {
  echo ""
  echo -e "${BOLD}Configuration${NC}"
  echo -e "${MUTED}────────────────────────────────────────${NC}"
  echo ""
  echo -e "Get your API key at: ${ACCENT}${HUB_URL}${NC}"
  echo ""
  
  if [ ! -t 0 ]; then
    echo -e "${INFO}Non-interactive mode. Configure manually:${NC}"
    echo "  openclaw config set plugins.entries.openfinclaw.config.backtestApiKey YOUR_KEY"
    return
  fi
  
  read -p "Enter Backtest API Key (press Enter to skip): " api_key
  
  if [ -n "$api_key" ]; then
    openclaw config set plugins.entries.openfinclaw.config.backtestApiKey "$api_key"
    
    read -p "Enter Backtest Server URL [https://backtest.openfinclaw.ai]: " base_url
    base_url="${base_url:-https://backtest.openfinclaw.ai}"
    
    openclaw config set plugins.entries.openfinclaw.config.backtestApiUrl "$base_url"
    echo ""
    echo -e "${SUCCESS}✓${NC} Configuration saved"
  else
    echo ""
    echo -e "${INFO}Skipped configuration. Configure later with:${NC}"
    echo "  openclaw config set plugins.entries.openfinclaw.config.backtestApiKey YOUR_KEY"
  fi
}

print_success() {
  echo ""
  echo -e "${SUCCESS}${BOLD}Installation complete!${NC}"
  echo ""
  
  echo "Installed plugins:"
  for id in "${SELECTED_PLUGINS[@]}"; do
    local name=$(get_plugin_field "$id" 2)
    local desc=$(get_plugin_field "$id" 4)
    echo -e "  ${SUCCESS}✓${NC} $name - $desc"
  done
  
  echo ""
  echo -e "${MUTED}Restart the Gateway to activate:${NC}"
  echo -e "  ${BOLD}openclaw gateway restart${NC}"
  echo ""
  echo -e "${MUTED}Repository:${NC} ${REPO_URL}"
  echo -e "${MUTED}Get API Key:${NC} ${HUB_URL}"
  echo ""
}

main() {
  print_banner
  check_openclaw
  select_plugins
  install_plugins
  configure_api_key
  print_success
}

main "$@"