#!/usr/bin/env bash
# SafeClaw Installer — https://safeclaw.sh
#
# Usage: curl -fsSL https://safeclaw.sh/install.sh | sh
#
# Checks Podman/Docker or Python, installs AEP safety proxy.

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
# Detect container runtime: prefer Podman, fall back to Docker
# Verify daemon is actually running, not just that the CLI exists
# ---------------------------------------------------------------------------
CONTAINER_CMD=""
if command -v podman &>/dev/null && podman info &>/dev/null; then
    CONTAINER_CMD="podman"
elif command -v docker &>/dev/null && docker info &>/dev/null; then
    CONTAINER_CMD="docker"
fi

# ---------------------------------------------------------------------------
# Interactive preference selector
# ---------------------------------------------------------------------------
if [ -t 0 ]; then
    if [ -n "$CONTAINER_CMD" ]; then
        runtime_label="$CONTAINER_CMD"
    else
        runtime_label="Podman/Docker"
    fi
    echo -e "  How do you want to run SafeClaw?"
    echo ""
    echo -e "  ${CYAN}[1]${NC} Container (${runtime_label}) ${GREEN}(recommended)${NC} — sandboxed, no access to your files"
    echo -e "  ${CYAN}[2]${NC} pip install — runs on host, developer mode"
    echo -e "  ${CYAN}[3]${NC} I already have it installed"
    echo ""
    printf "  Choice [1]: "
    read -r choice
    choice=${choice:-1}
else
    # Non-interactive (piped) — default to container if available, else pip
    if [ -n "$CONTAINER_CMD" ]; then
        choice=1
    else
        choice=2
    fi
fi

case "$choice" in
    1)
        # Container path
        if [ -z "$CONTAINER_CMD" ]; then
            echo -e "  ${RED}No container runtime found.${NC}"
            echo ""
            echo "  Install Podman (recommended): https://podman.io/docs/installation"
            echo "  Or Docker Desktop: https://docs.docker.com/get-docker/"
            echo "  Or choose option 2 (pip install) instead."
            exit 1
        fi

        echo -e "  ${CYAN}Pulling SafeClaw proxy image via ${CONTAINER_CMD}...${NC}"
        $CONTAINER_CMD pull ghcr.io/aceteam-ai/aep-proxy:latest 2>&1 | tail -3

        mkdir -p "$HOME/safeclaw"

        echo ""
        echo -e "  ${GREEN}${BOLD}Ready.${NC}"
        echo ""
        echo -e "  ${CYAN}Start SafeClaw:${NC}"
        echo ""
        echo "    $CONTAINER_CMD run -p 8899:8899 -v ~/safeclaw:/workspace ghcr.io/aceteam-ai/aep-proxy"
        echo ""
        echo -e "  ${CYAN}Dashboard:${NC}  http://localhost:8899/aep/"
        echo -e "  ${CYAN}API Keys:${NC}   Configure in Dashboard > Settings"
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
        # Use uv pip install with various fallback strategies for different environments
        if command -v uv &>/dev/null; then
            uv pip install --quiet "aceteam-aep[all]" --system 2>/dev/null || \
            UV_SYSTEM_PYTHON=1 uv pip install --quiet "aceteam-aep[all]" 2>/dev/null || \
            uv pip install --quiet "aceteam-aep[all]" 2>/dev/null || true
        fi

        # If uv failed or isn't used, try pip with --break-system-packages (for managed envs like Debian)
        if ! command -v aceteam-aep &>/dev/null; then
            pip install --quiet "aceteam-aep[all]" --break-system-packages 2>/dev/null || \
            python3 -m pip install --quiet "aceteam-aep[all]" --break-system-packages 2>/dev/null || \
            pip install --quiet "aceteam-aep[all]" 2>/dev/null || \
            python3 -m pip install --quiet "aceteam-aep[all]" 2>/dev/null || true
        fi

        if ! command -v aceteam-aep &>/dev/null; then
            echo -e "  ${RED}Installation failed.${NC} Please install aceteam-aep manually: pip install aceteam-aep[all]"
            exit 1
        fi

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

# ---------------------------------------------------------------------------
# Workshop outro — QR codes + coupon prompt
# ---------------------------------------------------------------------------
if [ -t 0 ] && command -v qrencode &>/dev/null; then
    echo -e "  ${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${BOLD}Connect with me on LinkedIn${NC}        ${BOLD}Star SafeClaw on GitHub${NC}"
    echo ""

    # Generate QR codes side by side
    LI_QR=$(qrencode -t UTF8 -m 1 "https://www.linkedin.com/in/sunapi386/" 2>/dev/null)
    GH_QR=$(qrencode -t UTF8 -m 1 "https://github.com/aceteam-ai/safeclaw" 2>/dev/null)

    if [ -n "$LI_QR" ] && [ -n "$GH_QR" ]; then
        paste <(echo "$LI_QR") <(echo "$GH_QR") | while IFS=$'\t' read -r left right; do
            printf "  %-36s  %s\n" "$left" "$right"
        done
    fi

    echo ""
    echo -e "  ${CYAN}linkedin.com/in/sunapi386${NC}          ${CYAN}github.com/aceteam-ai/safeclaw${NC}"
    echo ""
    echo -e "  ${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${BOLD}Reply ${GREEN}a${NC}${BOLD} to get a free SafeClaw hosted instance coupon!${NC}"
    echo ""
elif [ -t 0 ]; then
    echo -e "  ${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${BOLD}Connect:${NC}  ${CYAN}linkedin.com/in/sunapi386${NC}"
    echo -e "  ${BOLD}Star:${NC}     ${CYAN}github.com/aceteam-ai/safeclaw${NC}"
    echo ""
    echo -e "  ${BOLD}Reply ${GREEN}a${NC}${BOLD} to get a free SafeClaw hosted instance coupon!${NC}"
    echo ""
fi
