#!/usr/bin/env bash
set -euo pipefail

PROXY="${PROXY:-caddy}"
INSTALL_METHOD="${INSTALL_METHOD:-npm}"
GIT_REPO="${GIT_REPO:-https://github.com/cloud-neutral-toolkit/clawdbot.svc.plus.git}"
CLAWDBOT_VERSION="${CLAWDBOT_VERSION:-latest}"
PUBLIC_SCHEME="https"

usage() {
  cat <<'EOF'
Usage:
  init_macos.sh [domain]

Defaults:
  - domain: current hostname (hostname -f, then hostname)
  - clawdbot version: "latest" (override with CLAWDBOT_VERSION env var)
  - install method: npm (set INSTALL_METHOD=git to install from the cloned repo in /opt)
  - proxy: Caddy with automatic TLS (PROXY is always caddy on macOS)

Examples:
  ./init_macos.sh
  ./init_macos.sh clawdbot.svc.plus
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s 2>/dev/null || true)" != "Darwin" ]]; then
  echo "This installer is macOS-only."
  exit 1
fi

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  DOMAIN="$(hostname -f 2>/dev/null || true)"
  if [[ -z "$DOMAIN" ]]; then
    DOMAIN="$(hostname 2>/dev/null || true)"
  fi
fi

if [[ -z "$DOMAIN" ]]; then
  echo "Failed to determine domain (hostname). Pass one explicitly."
  exit 1
fi

PROXY="$(tr '[:upper:]' '[:lower:]' <<< "$PROXY")"
if [[ "$PROXY" != "caddy" ]]; then
  echo "Only PROXY=caddy is supported on macOS."
  exit 1
fi

INSTALL_METHOD="$(tr '[:upper:]' '[:lower:]' <<< "$INSTALL_METHOD")"
if [[ "$INSTALL_METHOD" != "npm" && "$INSTALL_METHOD" != "git" ]]; then
  echo "Unsupported install method '$INSTALL_METHOD'. Use 'npm' or 'git'."
  exit 1
fi

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    if [[ "${1:-}" == "-E" ]]; then
      shift
    fi
    "$@"
  else
    sudo "$@"
  fi
}

run_as_user() {
  local user="${SUDO_USER:-$USER}"
  if [[ "$user" == "root" ]]; then
    echo "Run this installer as a non-root user (with sudo available)."
    exit 1
  fi
  sudo -u "$user" -H "$@"
}

ensure_packages_darwin() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required on macOS. Install it from https://brew.sh and re-run."
    exit 1
  fi
  brew install git caddy curl
}

ensure_node24_darwin() {
  local need_install=1
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "${major:-0}" -ge 24 ]]; then
      need_install=0
    fi
  fi
  if [[ "$need_install" -eq 1 ]]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node@24 || brew install node
      if brew list node@24 >/dev/null 2>&1; then
        brew link --overwrite --force node@24
      fi
    else
      local arch pkg_name pkg_url pkg_path
      arch="$(uname -m)"
      case "$arch" in
        arm64) arch="arm64" ;;
        x86_64) arch="x64" ;;
        *)
          echo "Unsupported macOS architecture: ${arch}"
          exit 1
          ;;
      esac
      pkg_name="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ \
        | awk -F\" -v arch="$arch" '/node-v24.*-darwin-/{if ($2 ~ ("-darwin-" arch "\\.pkg$")) {print $2; exit}}')"
      if [[ -z "$pkg_name" ]]; then
        echo "Failed to find a Node.js v24 macOS installer."
        exit 1
      fi
      pkg_url="https://nodejs.org/dist/latest-v24.x/${pkg_name}"
      pkg_path="/tmp/${pkg_name}"
      curl -fsSL "$pkg_url" -o "$pkg_path"
      as_root installer -pkg "$pkg_path" -target /
    fi
  fi
}

ensure_pnpm() {
  run_as_user corepack enable
  run_as_user corepack prepare pnpm@latest --activate
}

install_clawdbot_npm() {
  as_root npm install -g "clawdbot@${CLAWDBOT_VERSION}"
}

install_clawdbot_git() {
  local install_dir="/opt/clawdbot-svc-plus"
  if [[ ! -d "$install_dir" ]]; then
    run_as_user mkdir -p "$install_dir"
    run_as_user git clone "$GIT_REPO" "$install_dir"
  else
    run_as_user git -C "$install_dir" fetch --all --prune
    run_as_user git -C "$install_dir" checkout main
    run_as_user git -C "$install_dir" reset --hard origin/main
  fi
  run_as_user bash -c "cd $install_dir && pnpm install && pnpm build"
  run_as_user npm install -g "$install_dir"
}

install_clawdbot() {
  if [[ "$INSTALL_METHOD" == "git" ]]; then
    install_clawdbot_git
  else
    install_clawdbot_npm
  fi
}

configure_clawdbot() {
  run_as_user clawdbot onboard --install-daemon
  run_as_user clawdbot config set gateway.trustedProxies.0 127.0.0.1
}

configure_caddy() {
  local service
  service="$(brew --prefix)/etc/Caddyfile"
  cat <<EOF | as_root tee "$service" >/dev/null
${DOMAIN} {
  reverse_proxy 127.0.0.1:18789
}
EOF
  brew services start caddy || brew services restart caddy
}

health_check_url() {
  local url="$1"
  for i in $(seq 1 5); do
    if curl -fsS --max-time 5 --retry 3 --retry-delay 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

run_health_checks() {
  if ! health_check_url http://127.0.0.1:18789; then
    echo "Warning: local gateway health check failed."
  fi
  local target="${PUBLIC_SCHEME}://${DOMAIN}"
  if ! health_check_url "${target}"; then
    echo "Warning: public health check failed for ${target}. TLS might not be active yet."
  fi
}

echo "==> Domain: ${DOMAIN}"
ensure_packages_darwin
ensure_node24_darwin
ensure_pnpm
install_clawdbot
configure_clawdbot
configure_caddy
run_health_checks

cat <<EOF

Done.
Gateway is listening on http://127.0.0.1:18789 and proxied via https://${DOMAIN}.
Access control and TLS are handled by CADDY.

If you need to tweak config later:
  - `clawdbot config get gateway.trustedProxies`
  - `tail -f /tmp/clawdbot/clawdbot-gateway.log`
EOF
