#!/bin/bash
set -euo pipefail

# OpenFinClaw Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
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
PLUGIN_NAME="@openfinclaw/openfinclaw"

print_banner() {
  echo ""
  echo -e "${ACCENT}${BOLD}  🦞 OpenFinClaw Installer${NC}"
  echo -e "${INFO}  Financial tools for OpenClaw${NC}"
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

install_plugin() {
  echo ""
  echo -e "${INFO}Installing ${PLUGIN_NAME}...${NC}"
  echo ""
  
  if openclaw plugins install "${PLUGIN_NAME}" 2>&1 | while read -r line; do
    case "$line" in
      *"Downloading"*) echo "  Downloading..." ;;
      *"Extracting"*) echo "  Extracting..." ;;
      *"Installing to"*) echo "  Installing..." ;;
      *"successfully"*) echo -e "  ${SUCCESS}✓${NC} Done" ;;
      *"already installed"*) echo -e "  ${INFO}Already installed${NC}" ;;
      *"Error"*|*"error"*|*"failed"*) echo -e "  ${WARN}$line${NC}" ;;
    esac
  done; then
    echo ""
    echo -e "${SUCCESS}✓${NC} OpenFinClaw installed successfully"
  else
    echo -e "${WARN}Installation may have issues. Check output above.${NC}"
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
    echo "  openclaw config set plugins.entries.openfinclaw.config.skillApiKey YOUR_KEY"
    return
  fi
  
  read -p "Enter Skill API Key (press Enter to skip): " api_key
  
  if [ -n "$api_key" ]; then
    openclaw config set plugins.entries.openfinclaw.config.skillApiKey "$api_key"
    
    read -p "Enter Skill Server URL [https://hub.openfinclaw.ai]: " base_url
    base_url="${base_url:-https://hub.openfinclaw.ai}"
    
    openclaw config set plugins.entries.openfinclaw.config.skillApiUrl "$base_url"
    echo ""
    echo -e "${SUCCESS}✓${NC} Configuration saved"
  else
    echo ""
    echo -e "${INFO}Skipped configuration. Configure later with:${NC}"
    echo "  openclaw config set plugins.entries.openfinclaw.config.skillApiKey YOUR_KEY"
  fi
}

print_success() {
  echo ""
  echo -e "${SUCCESS}${BOLD}Installation complete!${NC}"
  echo ""
  echo "Installed:"
  echo "  • @openfinclaw/openfinclaw"
  echo ""
  echo "Features:"
  echo "  • fin-strategy-builder - Create trading strategies from natural language"
  echo "  • backtest-remote      - Submit backtests to remote server"
  echo ""
  echo "Tools available:"
  echo "  • backtest_remote_submit   - Submit strategy ZIP"
  echo "  • backtest_remote_status   - Check task status"
  echo "  • backtest_remote_report   - Get full report"
  echo "  • backtest_remote_list     - List all tasks"
  echo "  • backtest_remote_cancel   - Cancel queued task"
  echo "  • backtest_remote_validate - Validate before submit"
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
  install_plugin
  configure_api_key
  print_success
}

main "$@"