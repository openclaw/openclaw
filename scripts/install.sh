#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="${QVERISBOT_INSTALL_PACKAGE:-@qverisai/qverisbot}"
INSTALL_METHOD="npm"
VERSION="${QVERISBOT_VERSION:-latest}"
NO_ONBOARD="${QVERISBOT_NO_ONBOARD:-${OPENCLAW_NO_ONBOARD:-0}}"
SET_NPM_PREFIX=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --install-method <npm|git>   Installation method (default: npm)
  --version <version|tag>       npm version/tag (default: latest)
  --set-npm-prefix              Set npm global prefix to ~/.npm-global
  --no-onboard                  Skip onboarding wizard
  -h, --help                    Show this help message
EOF
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

can_run_sudo_non_interactive() {
  command_exists sudo && sudo -n true >/dev/null 2>&1
}

install_unzip_with_known_package_manager() {
  if command_exists apt-get; then
    if [[ "$(id -u)" -eq 0 ]]; then
      apt-get update && apt-get install -y unzip
    elif can_run_sudo_non_interactive; then
      sudo apt-get update && sudo apt-get install -y unzip
    else
      return 1
    fi
    return 0
  fi

  if command_exists dnf; then
    if [[ "$(id -u)" -eq 0 ]]; then
      dnf install -y unzip
    elif can_run_sudo_non_interactive; then
      sudo dnf install -y unzip
    else
      return 1
    fi
    return 0
  fi

  if command_exists yum; then
    if [[ "$(id -u)" -eq 0 ]]; then
      yum install -y unzip
    elif can_run_sudo_non_interactive; then
      sudo yum install -y unzip
    else
      return 1
    fi
    return 0
  fi

  if command_exists zypper; then
    if [[ "$(id -u)" -eq 0 ]]; then
      zypper --non-interactive install unzip
    elif can_run_sudo_non_interactive; then
      sudo zypper --non-interactive install unzip
    else
      return 1
    fi
    return 0
  fi

  if command_exists apk; then
    if [[ "$(id -u)" -eq 0 ]]; then
      apk add --no-cache unzip
    elif can_run_sudo_non_interactive; then
      sudo apk add --no-cache unzip
    else
      return 1
    fi
    return 0
  fi

  if command_exists brew; then
    brew install unzip
    return 0
  fi

  return 1
}

ensure_unzip_for_fnm() {
  if command_exists unzip; then
    return 0
  fi

  echo "Missing dependency: unzip (required by fnm installer)."
  echo "Attempting to install unzip automatically..."

  if install_unzip_with_known_package_manager; then
    if command_exists unzip; then
      echo "Installed unzip successfully."
      return 0
    fi
  fi

  echo "Could not install unzip automatically." >&2
  echo "Install unzip manually, then rerun this installer." >&2
  echo "Examples:" >&2
  echo "  Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y unzip" >&2
  echo "  RHEL/Fedora:   sudo dnf install -y unzip" >&2
  echo "  macOS (brew):  brew install unzip" >&2
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --install-method)
        INSTALL_METHOD="${2:-}"
        shift 2
        ;;
      --version)
        VERSION="${2:-}"
        shift 2
        ;;
      --set-npm-prefix)
        SET_NPM_PREFIX=1
        shift
        ;;
      --no-onboard)
        NO_ONBOARD=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 2
        ;;
    esac
  done
}

ensure_node() {
  if command_exists node; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "${major:-0}" -ge 22 ]]; then
      return 0
    fi
  fi

  echo "Node.js 22+ not found. Installing it via fnm (Fast Node Manager)."
  echo "fnm may modify your shell profile (e.g., ~/.bashrc, ~/.zshrc) to be available in new terminal sessions."
  if ! command_exists curl; then
    echo "curl is required to install Node.js." >&2
    exit 1
  fi

  ensure_unzip_for_fnm

  curl -fsSL https://fnm.vercel.app/install | bash
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env --use-on-cd)"
  fnm install 22
  fnm use 22
}

ensure_pnpm() {
  if command_exists pnpm; then
    return 0
  fi
  corepack enable
  corepack prepare pnpm@10.23.0 --activate
}

configure_npm_prefix_if_requested() {
  if [[ "$SET_NPM_PREFIX" != "1" ]]; then
    return 0
  fi
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
}

run_onboard_after_npm_install() {
  if [[ "$NO_ONBOARD" == "1" ]]; then
    return 0
  fi

  # When the script is piped (curl … | bash), stdin is the pipe, not the
  # terminal.  Onboarding needs interactive input, so we reopen stdin from
  # /dev/tty.  If /dev/tty is unavailable (e.g. non-interactive CI), skip
  # onboarding gracefully.
  if [[ ! -t 0 ]]; then
    if [[ -e /dev/tty ]]; then
      exec </dev/tty
    else
      echo "Non-interactive shell detected; skipping onboarding."
      echo "Run 'qverisbot onboard' (or 'openclaw onboard') manually later."
      return 0
    fi
  fi

  if command_exists qverisbot; then
    qverisbot onboard
    return 0
  fi
  if command_exists openclaw; then
    openclaw onboard
    return 0
  fi

  echo "Warning: install finished but no CLI command found in PATH." >&2
}

install_from_npm() {
  configure_npm_prefix_if_requested
  echo "Installing ${PACKAGE_NAME}@${VERSION}..."
  npm i -g "${PACKAGE_NAME}@${VERSION}"
  run_onboard_after_npm_install
}

install_from_git() {
  local repo_url="${QVERISBOT_GIT_REPO:-https://github.com/QVerisAI/QVerisBot.git}"
  local target_dir="${QVERISBOT_GIT_DIR:-QVerisBot}"

  if [[ -e "$target_dir" ]]; then
    echo "Target directory already exists: $target_dir" >&2
    exit 1
  fi

  ensure_pnpm
  git clone "$repo_url" "$target_dir"
  (
    cd "$target_dir"
    pnpm install
    pnpm ui:build
    pnpm build
    if [[ "$NO_ONBOARD" != "1" ]]; then
      # Reopen stdin from /dev/tty when piped (curl … | bash) so the
      # interactive onboarding wizard can read user input.
      if [[ ! -t 0 ]]; then
        if [[ -e /dev/tty ]]; then
          exec </dev/tty
        else
          echo "Non-interactive shell detected; skipping onboarding."
          echo "Run 'pnpm openclaw onboard' manually later."
          NO_ONBOARD=1
        fi
      fi
      if [[ "$NO_ONBOARD" != "1" ]]; then
        pnpm openclaw onboard
      fi
    fi
  )
}

main() {
  parse_args "$@"
  if [[ "$INSTALL_METHOD" != "npm" && "$INSTALL_METHOD" != "git" ]]; then
    echo "Unsupported install method: $INSTALL_METHOD" >&2
    exit 2
  fi

  ensure_node
  if ! command_exists npm; then
    echo "npm not found after Node.js setup." >&2
    exit 1
  fi

  # Non-root users: use ~/.npm-global so CLI is in a writable location and on PATH
  if [[ "$(id -u)" -ne 0 && "$SET_NPM_PREFIX" != "1" ]]; then
    SET_NPM_PREFIX=1
  fi

  if [[ "$INSTALL_METHOD" == "git" ]]; then
    install_from_git
  else
    install_from_npm
  fi
}

main "$@"
