#!/usr/bin/env bash
# OpenClaw installer script
# Supports macOS, Debian/Ubuntu, Fedora/RHEL, Arch Linux, and other Linux distributions
#
# Usage:
#   curl -fsSL https://openclaw.ai/install.sh | bash
#   curl -fsSL https://openclaw.ai/install.sh | bash -s -- --help
#
# Environment variables:
#   OPENCLAW_INSTALL_METHOD=git|npm    Install method (default: npm)
#   OPENCLAW_GIT_DIR=<path>            Git checkout directory (default: ~/openclaw)
#   OPENCLAW_GIT_UPDATE=0|1            Skip git pull when using existing checkout
#   OPENCLAW_NO_PROMPT=1               Disable interactive prompts
#   OPENCLAW_DRY_RUN=1                 Print what would happen without making changes
#   OPENCLAW_NO_ONBOARD=1              Skip onboarding after install
#   SHARP_IGNORE_GLOBAL_LIBVIPS=0|1    Skip sharp native build (default: 1)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
INSTALL_METHOD="${OPENCLAW_INSTALL_METHOD:-npm}"
GIT_DIR="${OPENCLAW_GIT_DIR:-$HOME/openclaw}"
GIT_UPDATE="${OPENCLAW_GIT_UPDATE:-1}"
NO_PROMPT="${OPENCLAW_NO_PROMPT:-0}"
DRY_RUN="${OPENCLAW_DRY_RUN:-0}"
NO_ONBOARD="${OPENCLAW_NO_ONBOARD:-0}"
SHARP_IGNORE="${SHARP_IGNORE_GLOBAL_LIBVIPS:-1}"

PACKAGE_NAME="openclaw"
MIN_NODE_VERSION=22
REPO_URL="https://github.com/openclaw/openclaw.git"

# Logging functions
log_info() {
  echo -e "${BLUE}==>${NC} $1"
}

log_success() {
  echo -e "${GREEN}==>${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}Warning:${NC} $1"
}

log_error() {
  echo -e "${RED}Error:${NC} $1" >&2
}

# Print usage
usage() {
  cat <<EOF
OpenClaw Installer

Usage:
  curl -fsSL https://openclaw.ai/install.sh | bash [-- OPTIONS]

Options:
  --install-method <npm|git>  Install method (default: npm)
  --git-dir <path>            Git checkout directory (default: ~/openclaw)
  --no-git-update             Skip git pull when using existing checkout
  --no-prompt                 Disable interactive prompts
  --dry-run                   Print what would happen without making changes
  --no-onboard                Skip onboarding after install
  --help                      Show this help message

Environment Variables:
  OPENCLAW_INSTALL_METHOD     Same as --install-method
  OPENCLAW_GIT_DIR            Same as --git-dir
  OPENCLAW_GIT_UPDATE=0       Same as --no-git-update
  OPENCLAW_NO_PROMPT=1        Same as --no-prompt
  OPENCLAW_DRY_RUN=1          Same as --dry-run
  OPENCLAW_NO_ONBOARD=1       Same as --no-onboard
  SHARP_IGNORE_GLOBAL_LIBVIPS Skip sharp native build (default: 1)

EOF
  exit 0
}

# Parse command line arguments
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --install-method)
        INSTALL_METHOD="$2"
        shift 2
        ;;
      --git-dir)
        GIT_DIR="$2"
        shift 2
        ;;
      --no-git-update)
        GIT_UPDATE=0
        shift
        ;;
      --no-prompt)
        NO_PROMPT=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --no-onboard)
        NO_ONBOARD=1
        shift
        ;;
      --help|-h)
        usage
        ;;
      *)
        log_error "Unknown option: $1"
        usage
        ;;
    esac
  done
}

# Detect the operating system
detect_os() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ "$OSTYPE" == "linux-musl"* ]]; then
    echo "linux"
  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    log_error "Windows detected. Please use WSL2 or the PowerShell installer."
    log_error "PowerShell: iwr -useb https://openclaw.ai/install.ps1 | iex"
    exit 1
  else
    log_error "Unsupported operating system: $OSTYPE"
    exit 1
  fi
}

# Detect Linux distribution
detect_linux_distro() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    case "$ID" in
      debian|ubuntu|pop|linuxmint|elementary|zorin|kali|parrot)
        echo "debian"
        ;;
      fedora|rhel|centos|rocky|almalinux|ol)
        echo "fedora"
        ;;
      arch|manjaro|endeavouros|artix|arcolinux|cachyos|garuda|blackarch|parabola)
        echo "arch"
        ;;
      opensuse*|sles)
        echo "opensuse"
        ;;
      alpine)
        echo "alpine"
        ;;
      void)
        echo "void"
        ;;
      gentoo)
        echo "gentoo"
        ;;
      *)
        # Check for ID_LIKE as fallback
        case "${ID_LIKE:-}" in
          *debian*|*ubuntu*)
            echo "debian"
            ;;
          *fedora*|*rhel*)
            echo "fedora"
            ;;
          *arch*)
            echo "arch"
            ;;
          *suse*)
            echo "opensuse"
            ;;
          *)
            echo "unknown"
            ;;
        esac
        ;;
    esac
  else
    # Fallback: detect by package manager presence
    if command -v apt-get >/dev/null 2>&1; then
      echo "debian"
    elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
      echo "fedora"
    elif command -v pacman >/dev/null 2>&1; then
      echo "arch"
    elif command -v zypper >/dev/null 2>&1; then
      echo "opensuse"
    elif command -v apk >/dev/null 2>&1; then
      echo "alpine"
    elif command -v xbps-install >/dev/null 2>&1; then
      echo "void"
    elif command -v emerge >/dev/null 2>&1; then
      echo "gentoo"
    else
      echo "unknown"
    fi
  fi
}

# Check if a command exists
has_command() {
  command -v "$1" >/dev/null 2>&1
}

# Get current Node.js version (major)
get_node_version() {
  if has_command node; then
    node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
  else
    echo "0"
  fi
}

# Determine sudo or doas
get_sudo() {
  if [[ $EUID -eq 0 ]]; then
    echo ""
  elif has_command sudo; then
    echo "sudo"
  elif has_command doas; then
    echo "doas"
  else
    log_error "Neither sudo nor doas found. Please run as root or install sudo/doas."
    exit 1
  fi
}

# Install Node.js on macOS
install_node_macos() {
  log_info "Installing Node.js via Homebrew..."

  if ! has_command brew; then
    log_info "Homebrew not found. Installing Homebrew first..."
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "[dry-run] Would install Homebrew"
    else
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would run: brew install node@22"
  else
    brew install node@22 || brew upgrade node@22 || true
    # Link node if not already linked
    brew link --overwrite node@22 2>/dev/null || true
  fi
}

# Install Node.js on Debian-based systems
install_node_debian() {
  local sudo_cmd
  sudo_cmd="$(get_sudo)"

  log_info "Installing Node.js via NodeSource..."

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would install Node.js 22.x via NodeSource"
  else
    # Install prerequisites
    $sudo_cmd apt-get update
    $sudo_cmd apt-get install -y ca-certificates curl gnupg

    # Setup NodeSource repository
    $sudo_cmd mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $sudo_cmd gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

    NODE_MAJOR=22
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | $sudo_cmd tee /etc/apt/sources.list.d/nodesource.list

    $sudo_cmd apt-get update
    $sudo_cmd apt-get install -y nodejs
  fi
}

# Install Node.js on Fedora/RHEL-based systems
install_node_fedora() {
  local sudo_cmd
  sudo_cmd="$(get_sudo)"

  log_info "Installing Node.js via NodeSource..."

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would install Node.js 22.x via NodeSource"
  else
    # Setup NodeSource repository
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $sudo_cmd bash -

    if has_command dnf; then
      $sudo_cmd dnf install -y nodejs
    else
      $sudo_cmd yum install -y nodejs
    fi
  fi
}

# Install Node.js on Arch-based systems
install_node_arch() {
  local sudo_cmd
  sudo_cmd="$(get_sudo)"

  log_info "Installing Node.js and npm via pacman..."

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would run: $sudo_cmd pacman -Sy --noconfirm nodejs npm"
  else
    $sudo_cmd pacman -Sy --noconfirm nodejs npm
  fi
}

# Install Node.js on openSUSE
install_node_opensuse() {
  local sudo_cmd
  sudo_cmd="$(get_sudo)"

  log_info "Installing Node.js via zypper..."

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would run: $sudo_cmd zypper install -y nodejs22 npm22"
  else
    $sudo_cmd zypper install -y nodejs22 npm22
  fi
}

# Install Node.js on Alpine
install_node_alpine() {
  local sudo_cmd
  sudo_cmd="$(get_sudo)"

  log_info "Installing Node.js via apk..."

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would run: $sudo_cmd apk add nodejs npm"
  else
    $sudo_cmd apk add nodejs npm
  fi
}

# Install Node.js on Void Linux
install_node_void() {
  local sudo_cmd
  sudo_cmd="$(get_sudo)"

  log_info "Installing Node.js via xbps-install..."

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would run: $sudo_cmd xbps-install -Sy nodejs"
  else
    $sudo_cmd xbps-install -Sy nodejs
  fi
}

# Install git if not present
install_git() {
  if has_command git; then
    return 0
  fi

  log_info "Installing git..."

  local os
  os="$(detect_os)"

  if [[ "$os" == "macos" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "[dry-run] Would run: brew install git"
    else
      brew install git
    fi
  elif [[ "$os" == "linux" ]]; then
    local distro sudo_cmd
    distro="$(detect_linux_distro)"
    sudo_cmd="$(get_sudo)"

    case "$distro" in
      debian)
        if [[ "$DRY_RUN" == "1" ]]; then
          echo "[dry-run] Would run: $sudo_cmd apt-get install -y git"
        else
          $sudo_cmd apt-get update
          $sudo_cmd apt-get install -y git
        fi
        ;;
      fedora)
        if [[ "$DRY_RUN" == "1" ]]; then
          echo "[dry-run] Would run: $sudo_cmd dnf install -y git"
        else
          if has_command dnf; then
            $sudo_cmd dnf install -y git
          else
            $sudo_cmd yum install -y git
          fi
        fi
        ;;
      arch)
        if [[ "$DRY_RUN" == "1" ]]; then
          echo "[dry-run] Would run: $sudo_cmd pacman -Sy --noconfirm git"
        else
          $sudo_cmd pacman -Sy --noconfirm git
        fi
        ;;
      opensuse)
        if [[ "$DRY_RUN" == "1" ]]; then
          echo "[dry-run] Would run: $sudo_cmd zypper install -y git"
        else
          $sudo_cmd zypper install -y git
        fi
        ;;
      alpine)
        if [[ "$DRY_RUN" == "1" ]]; then
          echo "[dry-run] Would run: $sudo_cmd apk add git"
        else
          $sudo_cmd apk add git
        fi
        ;;
      void)
        if [[ "$DRY_RUN" == "1" ]]; then
          echo "[dry-run] Would run: $sudo_cmd xbps-install -Sy git"
        else
          $sudo_cmd xbps-install -Sy git
        fi
        ;;
      *)
        log_error "Could not detect package manager to install git."
        log_error "Please install git manually and re-run the installer."
        exit 1
        ;;
    esac
  fi
}

# Ensure Node.js is installed and meets minimum version
ensure_node() {
  local current_version
  current_version="$(get_node_version)"

  if [[ "$current_version" -ge "$MIN_NODE_VERSION" ]]; then
    log_success "Node.js v$current_version found (>= $MIN_NODE_VERSION required)"
    return 0
  fi

  if [[ "$current_version" -gt 0 ]]; then
    log_warn "Node.js v$current_version found, but v$MIN_NODE_VERSION+ is required"
  else
    log_info "Node.js not found"
  fi

  local os
  os="$(detect_os)"

  if [[ "$os" == "macos" ]]; then
    install_node_macos
  elif [[ "$os" == "linux" ]]; then
    local distro
    distro="$(detect_linux_distro)"

    case "$distro" in
      debian)
        install_node_debian
        ;;
      fedora)
        install_node_fedora
        ;;
      arch)
        install_node_arch
        ;;
      opensuse)
        install_node_opensuse
        ;;
      alpine)
        install_node_alpine
        ;;
      void)
        install_node_void
        ;;
      *)
        log_error "Could not detect package manager."
        log_error "Please install Node.js $MIN_NODE_VERSION+ manually:"
        log_error "  - Visit: https://nodejs.org/"
        log_error "  - Or use nvm: https://github.com/nvm-sh/nvm"
        exit 1
        ;;
    esac
  fi

  # Verify installation
  current_version="$(get_node_version)"
  if [[ "$current_version" -ge "$MIN_NODE_VERSION" ]]; then
    log_success "Node.js v$current_version installed successfully"
  else
    log_error "Failed to install Node.js $MIN_NODE_VERSION+"
    exit 1
  fi
}

# Setup npm global prefix for non-root users on Linux
setup_npm_prefix() {
  local os
  os="$(detect_os)"

  # Only needed on Linux for non-root users
  if [[ "$os" != "linux" ]] || [[ $EUID -eq 0 ]]; then
    return 0
  fi

  # Check if npm global prefix is writable
  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || echo "/usr/local")"

  if [[ -w "$npm_prefix/lib" ]] 2>/dev/null; then
    return 0
  fi

  log_info "Setting up npm global prefix in ~/.npm-global..."

  local npm_global="$HOME/.npm-global"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would create $npm_global and update npm prefix"
  else
    mkdir -p "$npm_global"
    npm config set prefix "$npm_global"

    # Add to PATH in shell config files
    local path_export="export PATH=\"\$HOME/.npm-global/bin:\$PATH\""

    for rc_file in "$HOME/.bashrc" "$HOME/.zshrc"; do
      if [[ -f "$rc_file" ]]; then
        if ! grep -q ".npm-global/bin" "$rc_file" 2>/dev/null; then
          echo "" >> "$rc_file"
          echo "# npm global packages" >> "$rc_file"
          echo "$path_export" >> "$rc_file"
        fi
      fi
    done

    # Update current shell PATH
    export PATH="$npm_global/bin:$PATH"
  fi

  log_success "npm global prefix set to $npm_global"
}

# Install via npm
install_npm() {
  log_info "Installing $PACKAGE_NAME via npm..."

  setup_npm_prefix

  # Set SHARP_IGNORE_GLOBAL_LIBVIPS to avoid native build issues
  export SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would run: npm install -g ${PACKAGE_NAME}@latest"
  else
    npm install -g "${PACKAGE_NAME}@latest"
  fi

  log_success "$PACKAGE_NAME installed via npm"
}

# Install via git
install_git_method() {
  log_info "Installing $PACKAGE_NAME from source..."

  # Ensure git is available
  install_git

  if [[ -d "$GIT_DIR/.git" ]]; then
    log_info "Existing checkout found at $GIT_DIR"

    if [[ "$GIT_UPDATE" == "1" ]]; then
      log_info "Updating checkout..."

      if [[ "$DRY_RUN" == "1" ]]; then
        echo "[dry-run] Would run: git -C $GIT_DIR pull --rebase"
      else
        cd "$GIT_DIR"

        # Check if working directory is clean
        if [[ -n "$(git status --porcelain)" ]]; then
          log_warn "Working directory has uncommitted changes. Skipping git pull."
        else
          git pull --rebase
        fi
      fi
    else
      log_info "Skipping git pull (--no-git-update)"
    fi
  else
    log_info "Cloning repository to $GIT_DIR..."

    if [[ "$DRY_RUN" == "1" ]]; then
      echo "[dry-run] Would run: git clone $REPO_URL $GIT_DIR"
    else
      git clone "$REPO_URL" "$GIT_DIR"
    fi
  fi

  if [[ "$DRY_RUN" != "1" ]]; then
    cd "$GIT_DIR"

    # Check for pnpm
    if ! has_command pnpm; then
      log_info "Installing pnpm..."
      npm install -g pnpm
    fi

    log_info "Installing dependencies..."
    pnpm install

    log_info "Building..."
    pnpm build
    pnpm ui:build

    log_info "Installing globally from source..."
    npm install -g .
  fi

  log_success "$PACKAGE_NAME installed from source"
}

# Run onboarding
run_onboard() {
  if [[ "$NO_ONBOARD" == "1" ]]; then
    log_info "Skipping onboarding (--no-onboard)"
    return 0
  fi

  log_info "Running onboarding..."

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would run: $PACKAGE_NAME onboard --install-daemon"
  else
    if has_command "$PACKAGE_NAME"; then
      "$PACKAGE_NAME" onboard --install-daemon || true
    else
      # Try from npm global path
      local npm_bin
      npm_bin="$(npm config get prefix 2>/dev/null)/bin"
      if [[ -x "$npm_bin/$PACKAGE_NAME" ]]; then
        "$npm_bin/$PACKAGE_NAME" onboard --install-daemon || true
      else
        log_warn "Could not find $PACKAGE_NAME binary for onboarding"
      fi
    fi
  fi
}

# Main installation flow
main() {
  parse_args "$@"

  log_info "OpenClaw Installer"
  log_info "=================="

  local os
  os="$(detect_os)"
  log_info "Detected OS: $os"

  if [[ "$os" == "linux" ]]; then
    local distro
    distro="$(detect_linux_distro)"
    log_info "Detected distribution: $distro"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log_warn "Dry run mode - no changes will be made"
  fi

  echo ""

  # Ensure Node.js is installed
  ensure_node

  echo ""

  # Install based on method
  case "$INSTALL_METHOD" in
    npm)
      install_npm
      ;;
    git)
      install_git_method
      ;;
    *)
      log_error "Unknown install method: $INSTALL_METHOD"
      log_error "Use --install-method npm or --install-method git"
      exit 1
      ;;
  esac

  echo ""

  # Run onboarding
  run_onboard

  echo ""
  log_success "Installation complete!"
  log_info "Run '$PACKAGE_NAME --help' to get started"

  # Remind about PATH if we set up npm-global
  if [[ -d "$HOME/.npm-global/bin" ]] && [[ ":$PATH:" != *":$HOME/.npm-global/bin:"* ]]; then
    echo ""
    log_warn "You may need to restart your shell or run:"
    log_warn "  export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
  fi
}

main "$@"
