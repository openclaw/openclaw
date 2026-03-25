#!/bin/bash

# 🦞 OpenClaw Universal Super-Installer for Raspberry Pi 5
# "The One-Click Sovereign Experience"

# Colors for professional UI
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}###############################################${NC}"
echo -e "${BLUE}#                                             #${NC}"
echo -e "${BLUE}#   🦞 WELCOME TO THE OPENCLAW PI 5 OS 🦞     #${NC}"
echo -e "${BLUE}#                                             #${NC}"
echo -e "${BLUE}###############################################${NC}"
echo ""

# 1. Check for Pi-Apps (The most popular Pi Store)
if [ -d "$HOME/pi-apps" ]; then
    echo -e "${GREEN}[+] Pi-Apps detected! Integrating OpenClaw into your Store...${NC}"
    mkdir -p "$HOME/pi-apps/apps/OpenClaw"
    wget -qO "$HOME/pi-apps/apps/OpenClaw/install" https://raw.githubusercontent.com/jhawpetoss6-collab/pi-apps-openclaw/main/apps/OpenClaw/install
    wget -qO "$HOME/pi-apps/apps/OpenClaw/uninstall" https://raw.githubusercontent.com/jhawpetoss6-collab/pi-apps-openclaw/main/apps/OpenClaw/uninstall
    wget -qO "$HOME/pi-apps/apps/OpenClaw/description" https://raw.githubusercontent.com/jhawpetoss6-collab/pi-apps-openclaw/main/apps/OpenClaw/description
    wget -qO "$HOME/pi-apps/apps/OpenClaw/website" https://raw.githubusercontent.com/jhawpetoss6-collab/pi-apps-openclaw/main/apps/OpenClaw/website
    chmod +x "$HOME/pi-apps/apps/OpenClaw/install" "$HOME/pi-apps/apps/OpenClaw/uninstall"
    echo -e "${GREEN}[!] OpenClaw is now available in your Pi-Apps GUI!${NC}"
fi

# 2. Run the Native Installer
echo -e "${BLUE}[+] Starting Native ARM64 Installation...${NC}"
wget -qO- https://raw.githubusercontent.com/jhawpetoss6-collab/pi-apps-openclaw/main/apps/OpenClaw/install | bash

# 3. Final Success Message
echo ""
echo -e "${GREEN}###############################################${NC}"
echo -e "${GREEN}#          OPENCLAW IS NOW INSTALLED!         #${NC}"
echo -e "${GREEN}###############################################${NC}"
echo -e "${BLUE}# 1. Desktop Icon created (Menu -> Utility)   #${NC}"
echo -e "${BLUE}# 2. Background Service enabled (Always-On)   #${NC}"
echo -e "${BLUE}# 3. Auto-Updater active (Runs every 4 hours) #${NC}"
echo -e "${GREEN}###############################################${NC}"
echo ""
echo -e "To start manually, type: ${BLUE}openclaw${NC}"
