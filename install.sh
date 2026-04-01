#!/usr/bin/env bash
# SafeClaw Installer — https://safeclaw.sh
#
# Usage: curl -fsSL https://safeclaw.sh/install.sh | sh
#
# Checks Docker or Python, installs AEP safety proxy.

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}  SafeClaw${NC}"
echo -e "${DIM}  The safe version of OpenClaw${NC}"
echo ""

# ---------------------------------------------------------------------------
# Interactive preference selector
# ---------------------------------------------------------------------------
if [ -t 0 ]; then
    echo -e "  How do you want to run SafeClaw?"
    echo ""
    echo -e "  ${CYAN}[1]${NC} Docker ${GREEN}(recommended)${NC} — sandboxed, no access to your files"
    echo -e "  ${CYAN}[2]${NC} pip install — runs on host, developer mode"
    echo -e "  ${CYAN}[3]${NC} I already have it installed"
    echo ""
    printf "  Choice [1]: "
    read -r choice
    choice=${choice:-1}
else
    # Non-interactive (piped) — default to Docker if available, else pip
    if command -v docker &>/dev/null; then
        choice=1
    else
        choice=2
    fi
fi

case "$choice" in
    1)
        # Docker path
        if ! command -v docker &>/dev/null; then
            echo -e "  ${RED}Docker not found.${NC}"
            echo ""
            echo "  Install Docker: https://docs.docker.com/get-docker/"
            echo "  Or choose option 2 (pip install) instead."
            exit 1
        fi

        echo -e "  ${CYAN}Pulling SafeClaw proxy image...${NC}"
        docker pull ghcr.io/aceteam-ai/aep-proxy:latest 2>&1 | tail -3

        mkdir -p "$HOME/safeclaw"

        echo ""
        echo -e "  ${GREEN}${BOLD}Ready.${NC}"
        echo ""
        echo -e "  ${CYAN}Start SafeClaw:${NC}"
        echo ""
        echo "    docker run -p 8899:8899 -e OPENAI_API_KEY=\$OPENAI_API_KEY -v ~/safeclaw:/workspace ghcr.io/aceteam-ai/aep-proxy"
        echo ""
        echo -e "  ${CYAN}Dashboard:${NC}  http://localhost:8899/aep/"
        echo -e "  ${CYAN}Workspace:${NC} ~/safeclaw (the only folder your agent can see)"
        echo ""
        echo -e "${DIM}  Your agent runs in a container. It can only access ~/safeclaw.${NC}"
        echo -e "${DIM}  No email, no credentials, no browser cookies. Just your workspace.${NC}"
        ;;
    2)
        # pip path
        if ! command -v uv &>/dev/null; then
            echo -e "  ${CYAN}Installing uv...${NC}"
            curl -LsSf https://astral.sh/uv/install.sh | sh
            export PATH="$HOME/.local/bin:$PATH"
        fi

        echo -e "  ${CYAN}Installing aceteam-aep...${NC}"
        uv pip install --system "aceteam-aep[all]" --quiet 2>/dev/null \
            || uv pip install "aceteam-aep[all]" --quiet

        echo ""
        echo -e "  ${GREEN}${BOLD}Ready.${NC}"
        echo ""
        echo -e "  ${CYAN}Start SafeClaw:${NC}"
        echo ""
        echo "    aceteam-aep proxy --port 8899"
        echo ""
        echo -e "  ${CYAN}Dashboard:${NC} http://localhost:8899/aep/"
        echo ""
        echo -e "  ${CYAN}Or wrap any agent:${NC}"
        echo ""
        echo "    aceteam-aep wrap -- python my_agent.py"
        ;;
    3)
        echo -e "  ${GREEN}Great.${NC} Run: aceteam-aep proxy --port 8899"
        echo -e "  Dashboard: http://localhost:8899/aep/"
        ;;
    *)
        echo -e "  ${RED}Invalid choice.${NC} Run this script again."
        exit 1
        ;;
esac

echo ""
echo -e "${DIM}  SafeClaw: github.com/aceteam-ai/safeclaw${NC}"
echo -e "${DIM}  Workshop: github.com/aceteam-ai/aep-quickstart/blob/main/workshop/bootcamp.html${NC}"
echo ""
