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

persist_npm_bin_in_shell_rc() {
  local bin_dir="$1"
  local shell_name
  shell_name="$(basename "${SHELL:-/bin/bash}")"
  local rc_file

  case "$shell_name" in
    zsh)  rc_file="$HOME/.zshrc" ;;
    fish) rc_file="$HOME/.config/fish/config.fish" ;;
    *)    rc_file="$HOME/.bashrc" ;;
  esac

  # Idempotent: skip if the bin dir is already referenced in the rc file
  if [[ -f "$rc_file" ]] && grep -qF "$bin_dir" "$rc_file"; then
    return 0
  fi

  mkdir -p "$(dirname "$rc_file")"

  if [[ "$shell_name" == "fish" ]]; then
    printf '\nset -gx PATH "%s" $PATH\n' "$bin_dir" >> "$rc_file"
  else
    printf '\nexport PATH="%s:$PATH"\n' "$bin_dir" >> "$rc_file"
  fi

  echo "Added $bin_dir to PATH in $rc_file"
}

configure_npm_prefix_if_requested() {
  if [[ "$SET_NPM_PREFIX" != "1" ]]; then
    return 0
  fi
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  persist_npm_bin_in_shell_rc "$HOME/.npm-global/bin"
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

  # Fallback: use the absolute path from npm prefix (PATH may not be
  # updated in the current shell when running via curl | bash).
  local npm_bin
  npm_bin="$(npm config get prefix)/bin"

  if [[ -x "$npm_bin/qverisbot" ]]; then
    "$npm_bin/qverisbot" onboard
    return 0
  fi
  if [[ -x "$npm_bin/openclaw" ]]; then
    "$npm_bin/openclaw" onboard
    return 0
  fi

  echo "Warning: install finished but no CLI command found in PATH." >&2
}

install_from_npm() {
  configure_npm_prefix_if_requested
  echo "Installing ${PACKAGE_NAME}@${VERSION}..."
  npm i -g "${PACKAGE_NAME}@${VERSION}"
  run_onboard_after_npm_install

  # Final reminder: if the user's current shell doesn't see the command,
  # tell them how to activate the PATH change we persisted earlier.
  if ! command_exists qverisbot && ! command_exists openclaw; then
    local npm_bin
    npm_bin="$(npm config get prefix)/bin"
    echo ""
    echo "Installation complete. To use 'qverisbot' in new terminals,"
    echo "restart your terminal or run:  source ~/.zshrc  (or your shell rc file)."
    echo ""
    echo "To run right now:  $npm_bin/qverisbot onboard"
  fi
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

resolve_beta_version() {
    local beta=""
    beta="$(npm view openclaw dist-tags.beta 2>/dev/null || true)"
    if [[ -z "$beta" || "$beta" == "undefined" || "$beta" == "null" ]]; then
        return 1
    fi
    echo "$beta"
}

install_openclaw() {
    local package_name="openclaw"
    if [[ "$USE_BETA" == "1" ]]; then
        local beta_version=""
        beta_version="$(resolve_beta_version || true)"
        if [[ -n "$beta_version" ]]; then
            OPENCLAW_VERSION="$beta_version"
            ui_info "Beta tag detected (${beta_version})"
            package_name="openclaw"
        else
            OPENCLAW_VERSION="latest"
            ui_info "No beta tag found; using latest"
        fi
    fi

    if [[ -z "${OPENCLAW_VERSION}" ]]; then
        OPENCLAW_VERSION="latest"
    fi

    local resolved_version=""
    resolved_version="$(npm view "${package_name}@${OPENCLAW_VERSION}" version 2>/dev/null || true)"
    if [[ -n "$resolved_version" ]]; then
        ui_info "Installing OpenClaw v${resolved_version}"
    else
        ui_info "Installing OpenClaw (${OPENCLAW_VERSION})"
    fi
    local install_spec=""
    if [[ "${OPENCLAW_VERSION}" == "latest" ]]; then
        install_spec="${package_name}@latest"
    else
        install_spec="${package_name}@${OPENCLAW_VERSION}"
    fi

    if ! install_openclaw_npm "${install_spec}"; then
        ui_warn "npm install failed; retrying"
        cleanup_npm_openclaw_paths
        install_openclaw_npm "${install_spec}"
    fi

    if [[ "${OPENCLAW_VERSION}" == "latest" && "${package_name}" == "openclaw" ]]; then
        if ! resolve_openclaw_bin &> /dev/null; then
            ui_warn "npm install openclaw@latest failed; retrying openclaw@next"
            cleanup_npm_openclaw_paths
            install_openclaw_npm "openclaw@next"
        fi
    fi

    ensure_openclaw_bin_link || true

    ui_success "OpenClaw installed"
}

run_doctor() {
    ui_info "Running doctor to migrate settings"
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        ui_info "Skipping doctor (openclaw not on PATH yet)"
        warn_openclaw_not_found
        return 0
    fi
    run_quiet_step "Running doctor" "$claw" doctor --non-interactive || true
    ui_success "Doctor complete"
}

maybe_open_dashboard() {
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        return 0
    fi
    if ! "$claw" dashboard --help >/dev/null 2>&1; then
        return 0
    fi
    "$claw" dashboard || true
}

resolve_workspace_dir() {
    local profile="${OPENCLAW_PROFILE:-default}"
    if [[ "${profile}" != "default" ]]; then
        echo "${HOME}/.openclaw/workspace-${profile}"
    else
        echo "${HOME}/.openclaw/workspace"
    fi
}

run_bootstrap_onboarding_if_needed() {
    if [[ "${NO_ONBOARD}" == "1" ]]; then
        return
    fi

    local config_path="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
    if [[ -f "${config_path}" || -f "$HOME/.clawdbot/clawdbot.json" || -f "$HOME/.moltbot/moltbot.json" || -f "$HOME/.moldbot/moldbot.json" ]]; then
        return
    fi

    local workspace
    workspace="$(resolve_workspace_dir)"
    local bootstrap="${workspace}/BOOTSTRAP.md"

    if [[ ! -f "${bootstrap}" ]]; then
        return
    fi

    if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
        ui_info "BOOTSTRAP.md found but no TTY; run openclaw onboard to finish setup"
        return
    fi

    ui_info "BOOTSTRAP.md found; starting onboarding"
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        ui_info "BOOTSTRAP.md found but openclaw not on PATH; skipping onboarding"
        warn_openclaw_not_found
        return
    fi

    "$claw" onboard || {
        ui_error "Onboarding failed; run openclaw onboard to retry"
        return
    }
}

load_install_version_helpers() {
    local source_path="${BASH_SOURCE[0]-}"
    local script_dir=""
    local helper_path=""
    if [[ -z "$source_path" || ! -f "$source_path" ]]; then
        return 0
    fi
    script_dir="$(cd "$(dirname "$source_path")" && pwd 2>/dev/null || true)"
    helper_path="${script_dir}/docker/install-sh-common/version-parse.sh"
    if [[ -n "$script_dir" && -r "$helper_path" ]]; then
        # shellcheck source=docker/install-sh-common/version-parse.sh
        source "$helper_path"
    fi
}

load_install_version_helpers

if ! declare -F extract_openclaw_semver >/dev/null 2>&1; then
# Inline fallback when version-parse.sh could not be sourced (for example, stdin install).
extract_openclaw_semver() {
    local raw="${1:-}"
    local parsed=""
    parsed="$(
        printf '%s\n' "$raw" \
            | tr -d '\r' \
            | grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?(\+[0-9A-Za-z.-]+)?' \
            | head -n 1 \
            || true
    )"
    printf '%s' "${parsed#v}"
}
fi

resolve_openclaw_version() {
    local version=""
    local raw_version_output=""
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]] && command -v openclaw &> /dev/null; then
        claw="$(command -v openclaw)"
    fi
    if [[ -n "$claw" ]]; then
        raw_version_output=$("$claw" --version 2>/dev/null | head -n 1 | tr -d '\r')
        version="$(extract_openclaw_semver "$raw_version_output")"
        if [[ -z "$version" ]]; then
            version="$raw_version_output"
        fi
    fi
    if [[ -z "$version" ]]; then
        local npm_root=""
        npm_root=$(npm root -g 2>/dev/null || true)
        if [[ -n "$npm_root" && -f "$npm_root/openclaw/package.json" ]]; then
            version=$(node -e "console.log(require('${npm_root}/openclaw/package.json').version)" 2>/dev/null || true)
        fi
    fi
    echo "$version"
}

is_gateway_daemon_loaded() {
    local claw="$1"
    if [[ -z "$claw" ]]; then
        return 1
    fi

    local status_json=""
    status_json="$("$claw" daemon status --json 2>/dev/null || true)"
    if [[ -z "$status_json" ]]; then
        return 1
    fi

    printf '%s' "$status_json" | node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8").trim();
if (!raw) process.exit(1);
try {
  const data = JSON.parse(raw);
  process.exit(data?.service?.loaded ? 0 : 1);
} catch {
  process.exit(1);
}
' >/dev/null 2>&1
}

refresh_gateway_service_if_loaded() {
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        return 0
    fi

    if ! is_gateway_daemon_loaded "$claw"; then
        return 0
    fi

    ui_info "Refreshing loaded gateway service"
    if run_quiet_step "Refreshing gateway service" "$claw" gateway install --force; then
        ui_success "Gateway service metadata refreshed"
    else
        ui_warn "Gateway service refresh failed; continuing"
        return 0
    fi

    if run_quiet_step "Restarting gateway service" "$claw" gateway restart; then
        ui_success "Gateway service restarted"
    else
        ui_warn "Gateway service restart failed; continuing"
        return 0
    fi

    run_quiet_step "Probing gateway service" "$claw" gateway status --probe --deep || true
}

# Main installation flow
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

if [[ "${OPENCLAW_INSTALL_SH_NO_RUN:-0}" != "1" ]]; then
  main "$@"
fi
