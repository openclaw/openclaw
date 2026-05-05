#!/usr/bin/env bash
# install.sh — One-line installer for OpenClaw VM
# Usage: curl -sSL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/virtualbox/install.sh | bash
# Or run locally from this repo: ./install.sh
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'
ORANGE='\033[38;5;209m'; DORANGE='\033[38;5;166m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

log()  { echo -e "  ${CYAN}→${NC} $1"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }

INSTALL_DIR="${OPENCLAW_VM_DIR:-$HOME/.openclaw-vm}"
VERSION="0.1.0"

echo ""
echo -e "${ORANGE}  ╔═══╗ ╔═══╗ ╔═══╗ ╔═╗ ╔╗${ORANGE} ╔═══╗ ╔╗   ╔═══╗ ╔╗   ╔╗${NC}"
echo -e "${ORANGE}  ║╔═╗║ ║╔═╗║ ║╔══╝ ║║╚╗║║${ORANGE} ║╔══╝ ║║   ║╔═╗║ ║║   ║║${NC}"
echo -e "${ORANGE}  ║║ ║║ ║╚═╝║ ║╚══╗ ║╔╗╚╝║${ORANGE} ║║    ║║   ║╚═╝║ ║║ ╔╗║║${NC}"
echo -e "${ORANGE}  ║║ ║║ ║╔══╝ ║╔══╝ ║║╚╗║║${ORANGE} ║║    ║║   ║╔═╗║ ║║╔╝╚╝║${NC}"
echo -e "${ORANGE}  ║╚═╝║ ║║    ║╚══╗ ║║ ║║║${ORANGE} ║╚══╗ ║╚═╗ ║║ ║║ ║╚╝╔╗╔╝${NC}"
echo -e "${ORANGE}  ╚═══╝ ╚╝    ╚═══╝ ╚╝ ╚═╝${ORANGE} ╚═══╝ ╚══╝ ╚╝ ╚╝ ╚══╝╚╝${NC}"
echo -e "  🦞${ORANGE}                                              VM v${VERSION}${NC}"

# ── Detect OS ─────────────────────────────────────────────────
OS="unknown"
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)      fail "Unsupported operating system. OpenClaw VM supports macOS and Linux." ;;
esac

ARCH="$(uname -m)"
echo -e "  ${DIM}OS: ${OS} / Arch: ${ARCH}${NC}"
echo ""

detect_linux_distro() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "${ID:-unknown}"
  else
    echo "unknown"
  fi
}

# ── Install VirtualBox ────────────────────────────────────────
if command -v VBoxManage &>/dev/null; then
  ok "VirtualBox already installed ($(VBoxManage --version 2>/dev/null | head -1))"
else
  case "$OS" in
    macos)
      if ! command -v brew &>/dev/null; then
        fail "Homebrew is required on macOS. Install it from https://brew.sh"
      fi
      log "Installing VirtualBox via Homebrew..."
      brew install --cask virtualbox
      ok "VirtualBox installed"
      ;;
    linux)
      distro=$(detect_linux_distro)
      case "$distro" in
        ubuntu|debian|pop|linuxmint)
          log "Installing VirtualBox via apt..."
          sudo apt-get update -qq
          sudo apt-get install -y -qq virtualbox virtualbox-ext-pack 2>/dev/null \
            || sudo apt-get install -y -qq virtualbox
          ;;
        fedora|rhel|centos|rocky|alma)
          log "Installing VirtualBox via dnf..."
          sudo dnf install -y VirtualBox 2>/dev/null || {
            sudo dnf install -y wget
            wget -q https://www.virtualbox.org/download/oracle_vbox_2016.asc -O- | sudo rpm --import - 2>/dev/null
            sudo wget -q "https://download.virtualbox.org/virtualbox/rpm/el/virtualbox.repo" -O /etc/yum.repos.d/virtualbox.repo 2>/dev/null
            sudo dnf install -y VirtualBox-7.1
          }
          ;;
        arch|manjaro|endeavouros)
          log "Installing VirtualBox via pacman..."
          sudo pacman -S --noconfirm virtualbox virtualbox-host-modules-arch
          ;;
        *)
          fail "Unsupported distro: $distro. Install VirtualBox manually: https://www.virtualbox.org/wiki/Linux_Downloads"
          ;;
      esac
      ok "VirtualBox installed"
      ;;
  esac
fi

# ── Install Vagrant ───────────────────────────────────────────
if command -v vagrant &>/dev/null; then
  ok "Vagrant already installed ($(vagrant --version 2>/dev/null))"
else
  case "$OS" in
    macos)
      log "Installing Vagrant via Homebrew..."
      brew install --cask vagrant
      ;;
    linux)
      distro=$(detect_linux_distro)
      case "$distro" in
        ubuntu|debian|pop|linuxmint)
          log "Installing Vagrant via apt..."
          if ! apt-cache show vagrant 2>/dev/null | grep -q "2\.[4-9]"; then
            wget -qO- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg 2>/dev/null
            echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list > /dev/null
            sudo apt-get update -qq
          fi
          sudo apt-get install -y -qq vagrant
          ;;
        fedora|rhel|centos|rocky|alma)
          log "Installing Vagrant via dnf..."
          sudo dnf install -y dnf-plugins-core 2>/dev/null
          sudo dnf config-manager --add-repo https://rpm.releases.hashicorp.com/fedora/hashicorp.repo 2>/dev/null
          sudo dnf install -y vagrant
          ;;
        arch|manjaro|endeavouros)
          log "Installing Vagrant via pacman..."
          sudo pacman -S --noconfirm vagrant
          ;;
        *)
          fail "Unsupported distro: $distro. Install Vagrant manually: https://developer.hashicorp.com/vagrant/install"
          ;;
      esac
      ok "Vagrant installed"
      ;;
  esac
fi

# ── Get the repo ─────────────────────────────────────────────
# Detect if we're running from inside the repo already (local run)
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
LOCAL_DIR=""
if [[ -n "$SCRIPT_SOURCE" ]] && [[ -f "$SCRIPT_SOURCE" ]]; then
  CANDIDATE="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  if [[ -f "$CANDIDATE/openclaw-vm" ]] && [[ -f "$CANDIDATE/Vagrantfile" ]]; then
    LOCAL_DIR="$CANDIDATE"
  fi
fi

if [[ -n "$LOCAL_DIR" ]]; then
  # Running locally from inside the repo — use it directly
  INSTALL_DIR="$LOCAL_DIR"
  ok "Using local repo at $INSTALL_DIR"
else
  fail "openclaw-vm must be run from the openclaw repository. Clone openclaw and run install.sh from scripts/virtualbox/"
fi

# ── Make executable ───────────────────────────────────────────
chmod +x "$INSTALL_DIR/openclaw-vm"

# ── Symlink to PATH ──────────────────────────────────────────
TARGET="/usr/local/bin/openclaw-vm"
REAL_PATH="$(cd "$INSTALL_DIR" && pwd)/openclaw-vm"
if [[ -L "$TARGET" ]] && [[ "$(readlink "$TARGET")" == "$REAL_PATH" ]]; then
  ok "openclaw-vm is on your PATH"
else
  log "Adding openclaw-vm to your PATH..."
  if [[ -w "/usr/local/bin" ]]; then
    ln -sf "$REAL_PATH" "$TARGET"
  else
    sudo ln -sf "$REAL_PATH" "$TARGET"
  fi
  ok "openclaw-vm is now available globally"
fi

echo ""
echo -e "  ${GREEN}${BOLD}Installation complete!${NC}"
echo ""
echo -e "  Get started:"
echo -e "    ${BOLD}openclaw-vm start${NC}    Interactive setup + boot the VM"
echo -e "    ${BOLD}openclaw-vm help${NC}     Show all commands"
echo ""
