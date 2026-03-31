#!/usr/bin/env bash
# install-openbodhi-cli.sh
# Installs the `openbodhi` command to ~/.local/bin/
#
# Usage:
#   bash ~/openbodhi/docs/bodhi/scripts/install-openbodhi-cli.sh
#
# Or from the repo root:
#   bash docs/bodhi/scripts/install-openbodhi-cli.sh

set -euo pipefail

GOLD='\033[38;2;212;175;55m'
SUCCESS='\033[38;2;80;200;120m'
MUTED='\033[38;2;100;100;120m'
ERROR='\033[38;2;210;60;60m'
BOLD='\033[1m'
NC='\033[0m'

# Locate repo root (script is at docs/bodhi/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BIN_SOURCE="$REPO_ROOT/bin/openbodhi"
INSTALL_DIR="$HOME/.local/bin"

echo ""
echo -e "${GOLD}${BOLD}  OpenBodhi CLI${NC}  ${MUTED}installer${NC}"
echo ""

# Verify source exists
if [[ ! -f "$BIN_SOURCE" ]]; then
  echo -e "  ${ERROR}✗ bin/openbodhi not found at:${NC}"
  echo -e "  ${MUTED}  $BIN_SOURCE${NC}"
  echo ""
  exit 1
fi

# Create install dir
mkdir -p "$INSTALL_DIR"

# Copy and make executable
cp "$BIN_SOURCE" "$INSTALL_DIR/openbodhi"
chmod +x "$INSTALL_DIR/openbodhi"

echo -e "  ${SUCCESS}✓ installed${NC}  ${MUTED}→ $INSTALL_DIR/openbodhi${NC}"
echo ""

# Check if ~/.local/bin is in PATH
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo -e "  ${GOLD}Add to PATH:${NC}"
  echo ""

  # Detect shell
  local_shell="$(basename "${SHELL:-bash}")"
  case "$local_shell" in
    zsh)
      RC_FILE="$HOME/.zshrc"
      ;;
    fish)
      RC_FILE="$HOME/.config/fish/config.fish"
      ;;
    *)
      RC_FILE="$HOME/.bashrc"
      ;;
  esac

  echo -e "  ${MUTED}Add this line to ${RC_FILE}:${NC}"
  echo -e "  ${MUTED}  export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
  echo ""
  echo -e "  ${MUTED}Then reload: source ${RC_FILE}${NC}"
  echo ""
  echo -e "  ${MUTED}Or run now: export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
  echo ""
else
  echo -e "  ${MUTED}PATH already includes ~/.local/bin${NC}"
  echo ""
  echo -e "  ${SUCCESS}Ready:${NC} ${GOLD}openbodhi${NC}"
  echo ""
fi

echo -e "  ${MUTED}Run setup:${NC}  ${GOLD}openbodhi setup${NC}"
echo ""
