#!/bin/bash
set -euo pipefail

# OpenFinClaw Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cryptoSUN2049/openFinclaw/main/scripts/install-finclaw.sh | bash
#
# This script installs the OpenFinClaw financial tools suite for OpenClaw.
# Repository: https://github.com/cryptoSUN2049/openFinclaw

BOLD='\033[1m'
ACCENT='\033[38;2;255;77;77m'
SUCCESS='\033[38;2;0;229;204m'
INFO='\033[38;2;136;146;176m'
WARN='\033[38;2;255;176;32m'
MUTED='\033[38;2;90;100;128m'
NC='\033[0m'

PLUGIN_NAME="@openfinclaw/openfinclaw"
REPO_URL="https://github.com/cryptoSUN2049/openFinclaw"
HUB_URL="https://hub.openfinclaw.ai"

print_banner() {
    echo ""
    echo -e "${ACCENT}${BOLD}  🦞 OpenFinClaw Installer${NC}"
    echo -e "${INFO}  Complete financial tools suite for OpenClaw${NC}"
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
    
    echo -e "${SUCCESS}✓${NC} OpenClaw is installed"
}

install_plugin() {
    echo ""
    echo -e "${INFO}Installing ${PLUGIN_NAME}...${NC}"
    
    if openclaw plugins install "${PLUGIN_NAME}"; then
        echo -e "${SUCCESS}✓${NC} Plugin installed successfully"
    else
        echo -e "${WARN}Plugin installation failed. Trying with npm...${NC}"
        npm install -g "${PLUGIN_NAME}"
    fi
}

configure_api_key() {
    echo ""
    echo -e "${BOLD}Configuration${NC}"
    echo -e "${MUTED}────────────────────────────────────────${NC}"
    echo ""
    echo -e "Get your API key at: ${ACCENT}${HUB_URL}${NC}"
    echo ""
    
    # Check if running interactively
    if [ -t 0 ]; then
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
            echo -e "${INFO}Skipped configuration. You can configure later with:${NC}"
            echo "  openclaw config set plugins.entries.openfinclaw.config.backtestApiKey YOUR_KEY"
        fi
    else
        echo -e "${INFO}Non-interactive mode. Configure manually:${NC}"
        echo "  openclaw config set plugins.entries.openfinclaw.config.backtestApiKey YOUR_KEY"
    fi
}

print_success() {
    echo ""
    echo -e "${SUCCESS}${BOLD}Installation complete!${NC}"
    echo ""
    echo "Installed features:"
    echo "  • fin-strategy-builder - Create trading strategies from natural language"
    echo "  • fin-backtest-remote  - Submit backtests to remote server"
    echo "  • fin-market-data      - Market data tools"
    echo "  • fin-strategy-engine  - Strategy lifecycle management"
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