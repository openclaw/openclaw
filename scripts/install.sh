#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/namastexlabs/openclaw.git"
REPO_BRANCH="namastex/main"
INSTALL_DIR="/opt/genie/openclaw"
BIN_DIR="/opt/genie/bin"
WRAPPER_PATH="${BIN_DIR}/openclaw"
NODE_VERSION="v24.13.1"
SERVICE_NAME="openclaw-gateway"
SERVICE_PORT="18789"

NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"
BUN_INSTALL_URL="https://bun.sh/install"
BREW_INSTALL_URL="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

SKIP_BUILD=0
SKIP_SERVICE=0
SHOW_HELP=0

BOLD='\033[1m'
ACCENT='\033[38;2;255;77;77m'
INFO='\033[38;2;136;146;176m'
SUCCESS='\033[38;2;0;229;204m'
WARN='\033[38;2;255;176;32m'
ERROR='\033[38;2;230;57;70m'
MUTED='\033[38;2;90;100;128m'
NC='\033[0m'

TARGET_USER=""
TARGET_HOME=""
TARGET_GROUP=""
TARGET_UID=""
BREW_BIN=""
NVM_DIR=""
NODE_BIN=""
NPM_BIN=""

log_section() { echo; echo -e "${ACCENT}${BOLD}$*${NC}"; }
log_info() { echo -e "${MUTED}·${NC} $*"; }
log_ok() { echo -e "${SUCCESS}✓${NC} $*"; }
log_warn() { echo -e "${WARN}!${NC} $*"; }
log_err() { echo -e "${ERROR}✗${NC} $*" >&2; }
die() { log_err "$*"; exit 1; }

on_err() {
  local code=$?
  log_err "Installer failed at line ${BASH_LINENO[0]} (exit ${code})."
  exit "${code}"
}
trap on_err ERR

usage() {
  cat <<'EOF'
Namastex OpenClaw Installer (Linux only)

Usage:
  bash install.sh [options]

Options:
  --skip-build      Skip `bun run build`
  --skip-service    Skip systemd user service install/start
  --port PORT       Gateway port (default: 18789)
  --help, -h        Show this help

This installer always:
  - Uses nvm-only Node v24.13.1
  - Uses Bun for install/build (runtime remains Node)
  - Installs Homebrew on Linux if missing
  - Clones/updates https://github.com/namastexlabs/openclaw.git (namastex/main)
  - Creates /opt/genie/bin/openclaw wrapper
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-build) SKIP_BUILD=1 ;;
      --skip-service) SKIP_SERVICE=1 ;;
      --port) shift; SERVICE_PORT="${1:?--port requires a value}" ;;
      --help|-h) SHOW_HELP=1 ;;
      *) die "Unknown option: $1 (use --help)" ;;
    esac
    shift
  done
}

require_linux() {
  [[ "$(uname -s)" == "Linux" ]] || die "Linux only. macOS/Windows are intentionally unsupported."
}

maybe_sudo() {
  if [[ ${EUID} -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

run_as_target() {
  if [[ ${EUID} -eq 0 && "${TARGET_USER}" != "root" ]]; then
    sudo -u "${TARGET_USER}" -H "$@"
  else
    "$@"
  fi
}

run_target_shell() {
  local cmd="$1"
  run_as_target bash -lc "${cmd}"
}

detect_target_user() {
  if [[ ${EUID} -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    TARGET_USER="${SUDO_USER}"
  else
    TARGET_USER="$(id -un)"
  fi
  TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
  TARGET_GROUP="$(id -gn "${TARGET_USER}")"
  TARGET_UID="$(id -u "${TARGET_USER}")"
  [[ -n "${TARGET_HOME}" ]] || die "Could not resolve home for ${TARGET_USER}"
}

resolve_brew_bin() {
  if command -v brew >/dev/null 2>&1; then
    BREW_BIN="$(command -v brew)"
    return 0
  fi
  [[ -x "${TARGET_HOME}/.linuxbrew/bin/brew" ]] && BREW_BIN="${TARGET_HOME}/.linuxbrew/bin/brew" && return 0
  [[ -x "/home/linuxbrew/.linuxbrew/bin/brew" ]] && BREW_BIN="/home/linuxbrew/.linuxbrew/bin/brew" && return 0
  return 1
}

ensure_homebrew_shellenv_in_bashrc() {
  local bashrc="${TARGET_HOME}/.bashrc"
  local prefix line
  prefix="$(run_target_shell "${BREW_BIN} --prefix")"
  line="eval \"\$(${prefix}/bin/brew shellenv)\""

  run_as_target touch "${bashrc}"
  if ! run_as_target grep -Fq "brew shellenv" "${bashrc}"; then
    run_as_target bash -lc "printf '\n%s\n' '${line}' >> '${bashrc}'"
    log_ok "Added Homebrew shellenv to ${bashrc}"
  else
    log_info "Homebrew shellenv already in ${bashrc}"
  fi
}

ensure_homebrew() {
  log_section "[1/10] Homebrew"
  if resolve_brew_bin; then
    log_ok "Homebrew found: ${BREW_BIN}"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required to install Homebrew"
    log_info "Installing Homebrew (Linuxbrew, non-interactive)..."
    run_target_shell "NONINTERACTIVE=1 /bin/bash -c \"\$(curl -fsSL ${BREW_INSTALL_URL})\""
    resolve_brew_bin || die "brew not found after installation"
    log_ok "Homebrew installed: ${BREW_BIN}"
  fi

  ensure_homebrew_shellenv_in_bashrc
  local prefix
  prefix="$(run_target_shell "${BREW_BIN} --prefix")"
  # shellcheck disable=SC1090
  eval "$(${prefix}/bin/brew shellenv)"
}

ensure_system_packages() {
  log_section "[2/10] System packages (Homebrew)"
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v curl >/dev/null 2>&1 || missing+=(curl)

  if [[ ${#missing[@]} -eq 0 ]]; then
    log_ok "git/curl already present"
    return
  fi

  log_info "Installing with brew: ${missing[*]}"
  run_target_shell "$(printf '%q ' "${BREW_BIN}" install "${missing[@]}")"
  log_ok "System packages installed"
}

ensure_nvm() {
  log_section "[3/10] nvm"
  NVM_DIR="${TARGET_HOME}/.nvm"

  if run_target_shell "[[ -s '${NVM_DIR}/nvm.sh' ]]"; then
    log_ok "nvm already installed"
  else
    log_info "Installing nvm..."
    run_target_shell "curl -fsSL '${NVM_INSTALL_URL}' | bash"
    run_target_shell "[[ -s '${NVM_DIR}/nvm.sh' ]]"
    log_ok "nvm installed"
  fi
}

ensure_node_via_nvm() {
  log_section "[4/10] Node.js ${NODE_VERSION} via nvm (required)"

  run_target_shell "
    set -euo pipefail
    export NVM_DIR='${NVM_DIR}'
    source \"\${NVM_DIR}/nvm.sh\"
    nvm install '${NODE_VERSION}'
    nvm alias default '${NODE_VERSION}'
    nvm use '${NODE_VERSION}' >/dev/null
  "

  NODE_BIN="${TARGET_HOME}/.nvm/versions/node/${NODE_VERSION}/bin/node"
  NPM_BIN="${TARGET_HOME}/.nvm/versions/node/${NODE_VERSION}/bin/npm"
  [[ -x "${NODE_BIN}" ]] || die "Node binary missing at ${NODE_BIN}"
  [[ -x "${NPM_BIN}" ]] || die "npm binary missing at ${NPM_BIN}"

  local version
  version="$(run_target_shell "'${NODE_BIN}' -v")"
  log_ok "Node ready: ${version}"
}

ensure_bun_path() {
  local bashrc="${TARGET_HOME}/.bashrc"
  local line='export PATH="$HOME/.bun/bin:$PATH"'
  run_as_target touch "${bashrc}"
  if ! run_as_target grep -Fq '/.bun/bin' "${bashrc}"; then
    run_as_target bash -lc "printf '\n%s\n' '${line}' >> '${bashrc}'"
    log_ok "Added Bun path to ${bashrc}"
  else
    log_info "Bun path already in ${bashrc}"
  fi
}

ensure_bun() {
  log_section "[5/10] Bun"
  if run_target_shell "export PATH='\$HOME/.bun/bin:\$PATH'; command -v bun >/dev/null 2>&1"; then
    log_ok "Bun already installed ($(run_target_shell "export PATH='\$HOME/.bun/bin:\$PATH'; bun --version"))"
  else
    log_info "Installing Bun..."
    run_target_shell "curl -fsSL '${BUN_INSTALL_URL}' | bash"
    log_ok "Bun installed ($(run_target_shell "export PATH='\$HOME/.bun/bin:\$PATH'; bun --version"))"
  fi
  ensure_bun_path
}

prepare_layout() {
  log_section "[6/10] Layout"
  maybe_sudo mkdir -p /opt/genie "${BIN_DIR}"
  maybe_sudo chown -R "${TARGET_USER}:${TARGET_GROUP}" /opt/genie
  log_ok "/opt/genie ready (${TARGET_USER}:${TARGET_GROUP})"
}

sync_repo() {
  log_section "[7/10] Repository sync"

  if [[ ! -d "${INSTALL_DIR}" ]]; then
    log_info "Cloning ${REPO_URL} (${REPO_BRANCH})"
    run_target_shell "git clone --branch '${REPO_BRANCH}' '${REPO_URL}' '${INSTALL_DIR}'"
    log_ok "Repository cloned"
    return
  fi

  [[ -d "${INSTALL_DIR}/.git" ]] || die "${INSTALL_DIR} exists but is not a git repository"

  if run_target_shell "cd '${INSTALL_DIR}' && [[ -n \"\$(git status --porcelain)\" ]]"; then
    log_warn "Local changes detected in ${INSTALL_DIR}; skipping git pull"
    log_warn "Commit/stash changes if you want installer-managed updates"
    return
  fi

  log_info "Updating existing repository"
  run_target_shell "cd '${INSTALL_DIR}' && git remote set-url origin '${REPO_URL}'"
  run_target_shell "cd '${INSTALL_DIR}' && git fetch origin '${REPO_BRANCH}'"
  run_target_shell "cd '${INSTALL_DIR}' && git checkout -B '${REPO_BRANCH}' 'origin/${REPO_BRANCH}'"
  run_target_shell "cd '${INSTALL_DIR}' && git pull --ff-only origin '${REPO_BRANCH}'"
  log_ok "Repository updated"
}

bun_install_and_build() {
  log_section "[8/10] bun install/build"

  run_target_shell "
    set -euo pipefail
    export NVM_DIR='${NVM_DIR}'
    source \"\${NVM_DIR}/nvm.sh\"
    nvm use '${NODE_VERSION}' >/dev/null
    export PATH='\$HOME/.bun/bin:\$PATH'
    cd '${INSTALL_DIR}'
    bun install
  "
  log_ok "bun install complete"

  if [[ ${SKIP_BUILD} -eq 1 ]]; then
    log_warn "Skipping build (--skip-build)"
    return
  fi

  run_target_shell "
    set -euo pipefail
    export NVM_DIR='${NVM_DIR}'
    source \"\${NVM_DIR}/nvm.sh\"
    nvm use '${NODE_VERSION}' >/dev/null
    export PATH='\$HOME/.bun/bin:\$PATH'
    cd '${INSTALL_DIR}'
    bun run build
  "
  log_ok "bun run build complete"
}

uninstall_global_openclaw_from_npm() {
  local npm_cmd="$1"
  if run_target_shell "${npm_cmd} list -g --depth=0 openclaw >/dev/null 2>&1"; then
    log_warn "npm-global openclaw detected via ${npm_cmd}; uninstalling"
    run_target_shell "${npm_cmd} uninstall -g openclaw || true"
    log_ok "Removed npm-global openclaw (${npm_cmd})"
  fi
}

install_wrapper_and_cleanup() {
  log_section "[9/10] Wrapper + stock cleanup"

  local wrapper='#!/bin/bash
exec "$HOME/.nvm/versions/node/v24.13.1/bin/node" "/opt/genie/openclaw/dist/index.js" "$@"'

  maybe_sudo mkdir -p "${BIN_DIR}"
  printf '%s
' "${wrapper}" | maybe_sudo tee "${WRAPPER_PATH}" >/dev/null
  maybe_sudo chmod +x "${WRAPPER_PATH}"
  maybe_sudo chown "${TARGET_USER}:${TARGET_GROUP}" "${WRAPPER_PATH}"
  log_ok "Wrapper installed: ${WRAPPER_PATH}"

  local bashrc="${TARGET_HOME}/.bashrc"
  local path_line='export PATH="/opt/genie/bin:$PATH"'
  run_as_target touch "${bashrc}"
  if ! run_as_target grep -Fq '/opt/genie/bin' "${bashrc}"; then
    run_as_target bash -lc "printf '\n%s\n' '${path_line}' >> '${bashrc}'"
    log_ok "Added /opt/genie/bin to ${bashrc}"
  else
    log_info "/opt/genie/bin already in ${bashrc}"
  fi

  uninstall_global_openclaw_from_npm "'${NPM_BIN}'"
  if run_target_shell "command -v npm >/dev/null 2>&1 && [ \"\$(command -v npm)\" != '${NPM_BIN}' ]"; then
    uninstall_global_openclaw_from_npm "npm"
  fi

  local found
  found="$(run_target_shell "command -v openclaw || true")"
  if [[ -n "${found}" && "${found}" != "${WRAPPER_PATH}" ]]; then
    log_warn "Stock/non-wrapper openclaw found in PATH: ${found}"
    log_warn "Expected wrapper: ${WRAPPER_PATH}"
  else
    log_ok "openclaw resolves to wrapper (or will after shell reload)"
  fi
}

ensure_linger() {
  # User-level systemd services need linger to survive logout
  if command -v loginctl >/dev/null 2>&1; then
    local linger_status
    linger_status="$(loginctl show-user "${TARGET_USER}" -p Linger 2>/dev/null || true)"
    if [[ "${linger_status}" == "Linger=yes" ]]; then
      log_ok "Linger already enabled for ${TARGET_USER}"
    else
      log_info "Enabling linger for ${TARGET_USER}..."
      if maybe_sudo loginctl enable-linger "${TARGET_USER}" 2>/dev/null; then
        log_ok "Linger enabled"
      else
        log_warn "Could not enable linger — service may stop on logout"
        log_warn "Fix: sudo loginctl enable-linger ${TARGET_USER}"
      fi
    fi
  else
    log_warn "loginctl not found — cannot check/enable linger"
  fi
}

systemctl_user() {
  # Run systemctl --user as the target user
  if [[ ${EUID} -eq 0 && "${TARGET_USER}" != "root" ]]; then
    sudo -u "${TARGET_USER}" -H env \
      XDG_RUNTIME_DIR="/run/user/${TARGET_UID}" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${TARGET_UID}/bus" \
      systemctl --user "$@"
  else
    systemctl --user "$@"
  fi
}

install_service() {
  if [[ ${SKIP_SERVICE} -eq 1 ]]; then
    log_warn "Skipping service setup (--skip-service)"
    return
  fi

  log_section "[10/10] systemd user service"
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found"

  ensure_linger

  local unit_dir="${TARGET_HOME}/.config/systemd/user"
  local unit_path="${unit_dir}/${SERVICE_NAME}.service"
  local node_exec="${TARGET_HOME}/.nvm/versions/node/${NODE_VERSION}/bin/node"
  local path_env="${TARGET_HOME}/.nvm/versions/node/${NODE_VERSION}/bin:${TARGET_HOME}/.bun/bin:/opt/genie/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"

  run_as_target mkdir -p "${unit_dir}"

  # If a service unit already exists (likely written by `openclaw doctor`),
  # back it up but let our template replace it. Doctor will re-own it
  # on next run with full environment injection.
  if [[ -f "${unit_path}" ]]; then
    run_as_target cp "${unit_path}" "${unit_path}.bak.$(date +%s)"
    log_info "Backed up existing service unit"
  fi

  # Write minimal unit file (upstream doctor will enrich on first run)
  run_as_target tee "${unit_path}" >/dev/null <<EOF
[Unit]
Description=OpenClaw Gateway (Namastex)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${node_exec} /opt/genie/openclaw/dist/index.js gateway --port ${SERVICE_PORT}
Restart=always
RestartSec=5
KillMode=process
WorkingDirectory=/opt/genie/openclaw
Environment=HOME=${TARGET_HOME}
Environment=PATH=${path_env}

[Install]
WantedBy=default.target
EOF

  log_ok "Service file written: ${unit_path}"
  systemctl_user daemon-reload || die "systemctl --user daemon-reload failed"
  systemctl_user enable "${SERVICE_NAME}" || die "enable failed for ${SERVICE_NAME}"

  if systemctl_user is-active --quiet "${SERVICE_NAME}"; then
    log_warn "${SERVICE_NAME} is currently running — NOT restarting automatically"
    log_warn "Run: systemctl --user restart ${SERVICE_NAME}"
  else
    systemctl_user start "${SERVICE_NAME}" || die "start failed for ${SERVICE_NAME}"
    log_ok "${SERVICE_NAME} started"
  fi
}

summary() {
  echo
  echo -e "${SUCCESS}${BOLD}OpenClaw Namastex install complete.${NC}"
  echo -e "${INFO}Repo:${NC}    ${INSTALL_DIR}"
  echo -e "${INFO}Wrapper:${NC} ${WRAPPER_PATH}"
  echo -e "${INFO}Node:${NC}    ${NODE_VERSION} via nvm"
  [[ ${SKIP_BUILD} -eq 1 ]] && echo -e "${WARN}Build:${NC}   skipped" || echo -e "${INFO}Build:${NC}   bun run build"
  [[ ${SKIP_SERVICE} -eq 1 ]] && echo -e "${WARN}Service:${NC} skipped" || echo -e "${INFO}Service:${NC} ${SERVICE_NAME} (port ${SERVICE_PORT})"
  echo -e "${MUTED}Tip:${NC} open a new shell or source ~/.bashrc"
}

main() {
  parse_args "$@"
  [[ ${SHOW_HELP} -eq 1 ]] && usage && exit 0

  require_linux
  detect_target_user
  log_info "Target user: ${TARGET_USER}"
  log_info "Target home: ${TARGET_HOME}"

  ensure_homebrew
  ensure_system_packages
  ensure_nvm
  ensure_node_via_nvm
  ensure_bun
  prepare_layout
  sync_repo
  bun_install_and_build
  install_wrapper_and_cleanup
  install_service
  summary
}

main "$@"
