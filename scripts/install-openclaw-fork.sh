#!/usr/bin/env bash
set -euo pipefail

# Installs SAW (Secure Agent Wallet) daemon and OpenClaw from a fork/tag.
#
# Recommended release usage (immutable):
#   OPENCLAW_REF=v2026.2.9-dreamclaw.8
#
# When OPENCLAW_REF is a tag, the script automatically checks for a prebuilt
# release tarball at GitHub Releases. If found, it installs from the tarball
# (fast, no build tools needed). Otherwise it falls back to git+https://
# which triggers a source build (requires pnpm + all devDeps).
#
# SAW setup (enabled by default, disable with SAW_INSTALL=0):
#   Downloads prebuilt SAW binaries, creates system users, generates wallet key,
#   writes conservative policy, installs systemd service, and starts daemon.
#
# Overrides:
#   OPENCLAW_SPEC=<npm-install-spec>       # optional direct spec (e.g. file:/path, git+https://...)
#   OPENCLAW_RELEASE_REPO=<github-url>     # repo URL for release tarballs (default: RedBeardEth/clawdbot)
#   OPENCLAW_REPO=https://github.com/<org>/<repo>.git  # for git+https:// fallback
#   OPENCLAW_REF=<tag-or-commit>         # preferred (immutable)
#   OPENCLAW_BRANCH=<branch>             # fallback for development
#   OPENCLAW_INSTALLER=npm|pnpm|auto
#   OPENCLAW_BIN=openclaw|moltbot
#   OPENCLAW_RUN_ONBOARD=1|0
#   OPENCLAW_ONBOARD_ARGS="onboard --install-daemon --auth-choice x402"
#   OPENCLAW_NPM_SCRIPT_SHELL=/path/to/sh  # optional npm lifecycle shell override
#
# SAW overrides:
#   SAW_INSTALL=1|0                        # enable/disable SAW phase (default: 1)
#   SAW_VERSION=<semver>                   # pin version, empty = fetch latest
#   SAW_ROOT=/opt/saw                      # data directory
#   SAW_SOCKET=/run/saw/saw.sock           # socket path
#   SAW_WALLET=main                        # wallet name for keygen
#   SAW_CHAIN=evm                          # chain for keygen
#   SAW_RELEASE_REPO=daydreamsai/agent-wallet
#   SAW_SERVICE_USER=saw                   # system user for daemon
#   SAW_AGENT_GROUP=saw-agent              # bridge group for socket access
#   SAW_GATEWAY_USER=<user>               # user to grant socket access (auto-detect if empty)
#   SAW_SKIP_KEYGEN=1|0                   # skip key generation
#   SAW_POLICY_TEMPLATE=conservative|none  # default policy template

# ── OpenClaw variables ──────────────────────────────────────────────────────

OPENCLAW_SPEC="${OPENCLAW_SPEC:-}"
OPENCLAW_REPO="${OPENCLAW_REPO:-https://github.com/RedBeardEth/clawdbot.git}"
OPENCLAW_REF="${OPENCLAW_REF:-}"
OPENCLAW_BRANCH="${OPENCLAW_BRANCH:-}"
OPENCLAW_INSTALLER="${OPENCLAW_INSTALLER:-npm}"
OPENCLAW_BIN="${OPENCLAW_BIN:-}"
OPENCLAW_RUN_ONBOARD="${OPENCLAW_RUN_ONBOARD:-1}"
OPENCLAW_ONBOARD_ARGS="${OPENCLAW_ONBOARD_ARGS:-onboard --install-daemon --auth-choice x402}"
OPENCLAW_NPM_SCRIPT_SHELL="${OPENCLAW_NPM_SCRIPT_SHELL:-}"

if [[ -z "$OPENCLAW_SPEC" && -z "$OPENCLAW_REF" && -z "$OPENCLAW_BRANCH" ]]; then
  OPENCLAW_REF="v2026.2.9-dreamclaw.9"
fi

if [[ -n "$OPENCLAW_SPEC" && ( -n "$OPENCLAW_REF" || -n "$OPENCLAW_BRANCH" ) ]]; then
  echo "ERROR: set OPENCLAW_SPEC or OPENCLAW_REF/OPENCLAW_BRANCH, not both" >&2
  exit 1
fi

if [[ -n "$OPENCLAW_REF" && -n "$OPENCLAW_BRANCH" ]]; then
  echo "ERROR: set only one of OPENCLAW_REF or OPENCLAW_BRANCH" >&2
  exit 1
fi

# ── SAW variables ───────────────────────────────────────────────────────────

SAW_INSTALL="${SAW_INSTALL:-1}"
SAW_VERSION="${SAW_VERSION:-}"
SAW_ROOT="${SAW_ROOT:-/opt/saw}"
SAW_SOCKET="${SAW_SOCKET:-/run/saw/saw.sock}"
SAW_WALLET="${SAW_WALLET:-main}"
SAW_CHAIN="${SAW_CHAIN:-evm}"
SAW_RELEASE_REPO="${SAW_RELEASE_REPO:-daydreamsai/agent-wallet}"
SAW_SERVICE_USER="${SAW_SERVICE_USER:-saw}"
SAW_AGENT_GROUP="${SAW_AGENT_GROUP:-saw-agent}"
SAW_GATEWAY_USER="${SAW_GATEWAY_USER:-}"
SAW_SKIP_KEYGEN="${SAW_SKIP_KEYGEN:-0}"
SAW_POLICY_TEMPLATE="${SAW_POLICY_TEMPLATE:-conservative}"

# ── SAW functions ───────────────────────────────────────────────────────────

saw_detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)  SAW_OS_NAME="linux" ;;
    Darwin) SAW_OS_NAME="macos" ;;
    *)      echo "ERROR: SAW requires Linux or macOS, got $os" >&2; return 1 ;;
  esac
  case "$arch" in
    x86_64|amd64)  SAW_ARCH="x86_64" ;;
    arm64|aarch64) SAW_ARCH="arm64" ;;
    *)             echo "ERROR: Unsupported architecture: $arch" >&2; return 1 ;;
  esac
  SAW_ARCHIVE="saw-${SAW_OS_NAME}-${SAW_ARCH}.tar.gz"
}

saw_resolve_version() {
  if [[ -n "$SAW_VERSION" ]]; then
    echo "==> SAW: using pinned version v${SAW_VERSION}"
    return 0
  fi
  SAW_VERSION=$(curl -sSL -H "Accept: application/json" \
    "https://api.github.com/repos/${SAW_RELEASE_REPO}/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p')
  if [[ -z "$SAW_VERSION" ]]; then
    echo "ERROR: could not determine latest SAW version from GitHub" >&2
    return 1
  fi
  echo "==> SAW: latest version v${SAW_VERSION}"
}

saw_download_and_install() {
  # Idempotency: check existing version
  if command -v saw >/dev/null 2>&1; then
    local existing_version
    existing_version="$(saw --version 2>/dev/null | sed -n 's/.*\([0-9]\+\.[0-9]\+\.[0-9]\+\).*/\1/p' || true)"
    if [[ "$existing_version" == "$SAW_VERSION" ]]; then
      echo "==> SAW: v${SAW_VERSION} already installed, skipping download"
      return 0
    fi
    echo "==> SAW: upgrading from v${existing_version:-unknown} to v${SAW_VERSION}"
  fi

  local url="https://github.com/${SAW_RELEASE_REPO}/releases/download/v${SAW_VERSION}/${SAW_ARCHIVE}"
  local tmpdir
  tmpdir="$(mktemp -d)"

  echo "==> SAW: downloading ${SAW_ARCHIVE}..."
  if ! curl -sSL -o "${tmpdir}/${SAW_ARCHIVE}" "$url"; then
    echo "ERROR: SAW download failed: $url" >&2
    rm -rf "$tmpdir"
    return 1
  fi

  tar xzf "${tmpdir}/${SAW_ARCHIVE}" -C "$tmpdir"
  sudo cp "${tmpdir}/saw" "${tmpdir}/saw-daemon" /usr/local/bin/
  sudo chmod 755 /usr/local/bin/saw /usr/local/bin/saw-daemon
  rm -rf "$tmpdir"
  echo "==> SAW: binaries installed to /usr/local/bin/"
}

saw_create_users() {
  if ! id "$SAW_SERVICE_USER" &>/dev/null; then
    if getent group "$SAW_SERVICE_USER" &>/dev/null; then
      # Group already exists (e.g. from a previous partial run) — use it as primary
      sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$SAW_SERVICE_USER" "$SAW_SERVICE_USER"
    else
      sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$SAW_SERVICE_USER"
    fi
    echo "==> SAW: created system user '$SAW_SERVICE_USER'"
  else
    echo "==> SAW: system user '$SAW_SERVICE_USER' already exists"
  fi

  if ! getent group "$SAW_AGENT_GROUP" &>/dev/null; then
    sudo groupadd --system "$SAW_AGENT_GROUP"
    echo "==> SAW: created group '$SAW_AGENT_GROUP'"
  else
    echo "==> SAW: group '$SAW_AGENT_GROUP' already exists"
  fi

  if ! id -nG "$SAW_SERVICE_USER" 2>/dev/null | grep -qw "$SAW_AGENT_GROUP"; then
    sudo usermod -aG "$SAW_AGENT_GROUP" "$SAW_SERVICE_USER"
    echo "==> SAW: added '$SAW_SERVICE_USER' to group '$SAW_AGENT_GROUP'"
  fi
}

saw_init_root() {
  if [[ -d "$SAW_ROOT/keys" ]]; then
    echo "==> SAW: data directory already initialized at $SAW_ROOT"
    return 0
  fi
  sudo /usr/local/bin/saw install --root "$SAW_ROOT"
  echo "==> SAW: initialized data directory at $SAW_ROOT"
}

saw_generate_key() {
  if [[ "$SAW_SKIP_KEYGEN" == "1" ]]; then
    echo "==> SAW: skipping key generation (SAW_SKIP_KEYGEN=1)"
    return 0
  fi

  local key_file="${SAW_ROOT}/keys/${SAW_CHAIN}/${SAW_WALLET}.key"
  if [[ -f "$key_file" ]]; then
    echo "==> SAW: wallet '${SAW_WALLET}' already exists for chain '${SAW_CHAIN}'"
    sudo /usr/local/bin/saw address --chain "$SAW_CHAIN" --wallet "$SAW_WALLET" --root "$SAW_ROOT" 2>/dev/null || true
    return 0
  fi

  echo "==> SAW: generating key (chain=${SAW_CHAIN}, wallet=${SAW_WALLET})"
  sudo /usr/local/bin/saw gen-key --chain "$SAW_CHAIN" --wallet "$SAW_WALLET" --root "$SAW_ROOT"
  echo "==> SAW: key generated on-device (never exported)"
  echo ""
  echo "    IMPORTANT: Fund this wallet address with ETH (gas) and USDC on Base"
  echo "    before using x402 payments."
  echo ""
}

saw_write_policy() {
  local policy_file="${SAW_ROOT}/policy.yaml"

  if [[ "$SAW_POLICY_TEMPLATE" == "none" ]]; then
    echo "==> SAW: skipping policy template (SAW_POLICY_TEMPLATE=none)"
    return 0
  fi

  if [[ -f "$policy_file" ]] && sudo grep -q "^  ${SAW_WALLET}:" "$policy_file" 2>/dev/null; then
    echo "==> SAW: policy already configured for wallet '${SAW_WALLET}', skipping"
    return 0
  fi

  echo "==> SAW: writing conservative default policy"
  sudo tee "$policy_file" > /dev/null << 'POLICY_EOF'
wallets:
  main:
    chain: evm
    allowed_chains: [8453]
    max_tx_value_eth: 0.01
    allow_contract_calls: false
    allowlist_addresses: []
    rate_limit_per_minute: 10
POLICY_EOF
  echo ""
  echo "    NOTE: The default policy has an EMPTY allowlist."
  echo "    SAW will deny all signing requests until you add the x402"
  echo "    facilitator address to allowlist_addresses in:"
  echo "      ${policy_file}"
  echo ""
}

saw_fix_permissions() {
  sudo chown -R "$SAW_SERVICE_USER:$SAW_SERVICE_USER" "$SAW_ROOT"
  sudo find "$SAW_ROOT/keys" -type d -exec chmod 0700 {} \;
  sudo find "$SAW_ROOT/keys" -type f -exec chmod 0600 {} \;
  sudo chmod 0640 "$SAW_ROOT/policy.yaml"
  if [[ -f "$SAW_ROOT/audit.log" ]]; then
    sudo chmod 0640 "$SAW_ROOT/audit.log"
  fi
  echo "==> SAW: permissions hardened"
}

saw_install_systemd() {
  local service_dest="/etc/systemd/system/saw.service"

  sudo tee "$service_dest" > /dev/null << SERVICE_EOF
[Unit]
Description=Secure Agent Wallet Daemon
After=network.target

[Service]
Type=simple
User=${SAW_SERVICE_USER}
Group=${SAW_SERVICE_USER}
SupplementaryGroups=${SAW_AGENT_GROUP}
ExecStart=/usr/local/bin/saw-daemon --socket ${SAW_SOCKET} --root ${SAW_ROOT}
Restart=on-failure
RestartSec=2

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictAddressFamilies=AF_UNIX
MemoryDenyWriteExecute=true
LockPersonality=true
ReadWritePaths=${SAW_ROOT}

# Runtime directories
RuntimeDirectory=saw
RuntimeDirectoryMode=0755

[Install]
WantedBy=multi-user.target
SERVICE_EOF

  sudo systemctl daemon-reload
  sudo systemctl enable saw
  echo "==> SAW: systemd service installed and enabled"
}

saw_start_and_verify() {
  sudo systemctl restart saw
  echo "==> SAW: daemon starting..."

  local waited=0
  while [[ ! -S "$SAW_SOCKET" ]] && (( waited < 50 )); do
    sleep 0.1
    (( waited++ )) || true
  done

  if [[ -S "$SAW_SOCKET" ]]; then
    echo "==> SAW: daemon running, socket at $SAW_SOCKET"
  else
    echo "WARNING: SAW socket not found after 5s at $SAW_SOCKET" >&2
    echo "    Check: sudo systemctl status saw" >&2
    echo "    Check: sudo journalctl -u saw --no-pager -n 20" >&2
  fi
}

saw_grant_gateway_access() {
  local gateway_user="${SAW_GATEWAY_USER}"

  if [[ -z "$gateway_user" ]]; then
    if id "moltbot" &>/dev/null; then
      gateway_user="moltbot"
    elif id "openclaw" &>/dev/null; then
      gateway_user="openclaw"
    else
      gateway_user="$(whoami)"
    fi
  fi

  if [[ "$gateway_user" == "root" ]]; then
    echo "==> SAW: running as root, socket access already available"
    return 0
  fi

  if id -nG "$gateway_user" 2>/dev/null | grep -qw "$SAW_AGENT_GROUP"; then
    echo "==> SAW: user '$gateway_user' already in group '$SAW_AGENT_GROUP'"
  else
    sudo usermod -aG "$SAW_AGENT_GROUP" "$gateway_user"
    echo "==> SAW: added '$gateway_user' to group '$SAW_AGENT_GROUP' (socket access)"
  fi
}

# ── Phase 1: SAW daemon setup ──────────────────────────────────────────────

if [[ "$SAW_INSTALL" == "1" ]]; then
  echo ""
  echo "============================================"
  echo "  Phase 1: SAW Daemon Setup"
  echo "============================================"
  echo ""
  saw_detect_platform
  saw_resolve_version
  saw_download_and_install
  saw_create_users
  saw_init_root
  saw_generate_key
  saw_write_policy
  saw_fix_permissions
  saw_install_systemd
  saw_start_and_verify
  saw_grant_gateway_access
  echo ""
  echo "==> SAW setup complete"
  echo ""
else
  echo "==> Skipping SAW setup (SAW_INSTALL=${SAW_INSTALL})"
fi

# ── Phase 2: OpenClaw gateway install ──────────────────────────────────────

echo ""
echo "============================================"
echo "  Phase 2: OpenClaw Gateway Install"
echo "============================================"
echo ""

OPENCLAW_RELEASE_REPO="${OPENCLAW_RELEASE_REPO:-https://github.com/RedBeardEth/clawdbot}"

resolve_release_tarball_url() {
  local tag="$1"
  local repo_url="${OPENCLAW_RELEASE_REPO%.git}"
  local tarball_url="${repo_url}/releases/download/${tag}/openclaw-${tag}.tgz"
  if curl -fsSL --head --connect-timeout 5 "$tarball_url" >/dev/null 2>&1; then
    printf '%s\n' "$tarball_url"
    return 0
  fi
  return 1
}

if [[ -n "$OPENCLAW_SPEC" ]]; then
  SPEC="$OPENCLAW_SPEC"
  REF_KIND="spec"
elif [[ -n "$OPENCLAW_REF" ]]; then
  tarball_url="$(resolve_release_tarball_url "$OPENCLAW_REF" || true)"
  if [[ -n "$tarball_url" ]]; then
    SPEC="$tarball_url"
    REF_KIND="release-tarball"
    echo "==> Found prebuilt release tarball for ${OPENCLAW_REF}"
  else
    SPEC="git+${OPENCLAW_REPO}#${OPENCLAW_REF}"
    REF_KIND="ref"
    echo "==> No prebuilt tarball found; falling back to git source install (requires pnpm + build tools)"
  fi
elif [[ -n "$OPENCLAW_BRANCH" ]]; then
  SPEC="git+${OPENCLAW_REPO}#${OPENCLAW_BRANCH}"
  REF_KIND="branch"
else
  echo "ERROR: provide OPENCLAW_REF (recommended) or OPENCLAW_BRANCH" >&2
  exit 1
fi

echo "==> Installing from ${SPEC} (${REF_KIND})"

resolve_npm_script_shell() {
  shell_works() {
    local candidate="$1"
    [[ -n "$candidate" && -x "$candidate" ]] || return 1
    "$candidate" -c "exit 0" >/dev/null 2>&1
  }

  if [[ -n "$OPENCLAW_NPM_SCRIPT_SHELL" ]]; then
    shell_works "$OPENCLAW_NPM_SCRIPT_SHELL" || {
      echo "ERROR: OPENCLAW_NPM_SCRIPT_SHELL is not executable/usable: $OPENCLAW_NPM_SCRIPT_SHELL" >&2
      return 1
    }
    printf '%s\n' "$OPENCLAW_NPM_SCRIPT_SHELL"
    return 0
  fi

  local c
  if shell_works "${BASH:-}"; then
    printf '%s\n' "$BASH"
    return 0
  fi

  # Prefer stable absolute paths to avoid bad shell hashes/aliases.
  for c in /bin/sh /usr/bin/sh /bin/bash /usr/bin/bash; do
    if shell_works "$c"; then
      printf '%s\n' "$c"
      return 0
    fi
  done

  c="$(command -v sh || command -v bash || true)"
  if shell_works "$c"; then
    printf '%s\n' "$c"
    return 0
  fi
  c="$(command -v bash || true)"
  if shell_works "$c"; then
    printf '%s\n' "$c"
    return 0
  fi

  return 1
}

resolve_path() {
  local input="$1"
  readlink -f "$input" 2>/dev/null || realpath "$input" 2>/dev/null || printf '%s\n' ""
}

run_npm() {
  local npm_bin npm_bin_dir npm_cli npm_node
  npm_bin="$(command -v npm || true)"
  if [[ -z "$npm_bin" ]]; then
    echo "ERROR: npm is not available in PATH" >&2
    return 1
  fi

  npm_bin_dir="$(dirname "$npm_bin")"
  npm_cli="$(resolve_path "$npm_bin")"
  npm_node="${npm_bin_dir}/node"

  if [[ -n "$npm_cli" && -f "$npm_cli" && -x "$npm_node" ]]; then
    "$npm_node" "$npm_cli" "$@"
    return 0
  fi

  "$npm_bin" "$@"
}

GLOBAL_BIN_HINT=""

if [[ "$OPENCLAW_INSTALLER" == "pnpm" ]] || [[ "$OPENCLAW_INSTALLER" == "auto" && -x "$(command -v pnpm || true)" ]]; then
  echo "==> Using pnpm global install"
  pnpm add -g "$SPEC"
  GLOBAL_BIN_HINT="$(pnpm bin -g 2>/dev/null || true)"
else
  if [[ "$OPENCLAW_INSTALLER" != "auto" && "$OPENCLAW_INSTALLER" != "npm" ]]; then
    echo "ERROR: unsupported OPENCLAW_INSTALLER='$OPENCLAW_INSTALLER' (expected auto|npm|pnpm)" >&2
    exit 1
  fi
  echo "==> Using npm global install"
  # Keep the caller's PATH order to avoid Node/npm version mismatches.
  npm_shell="$(resolve_npm_script_shell || true)"
  if [[ -z "${npm_shell:-}" ]]; then
    echo "ERROR: could not find a usable shell for npm lifecycle scripts." >&2
    echo "Set OPENCLAW_NPM_SCRIPT_SHELL to a valid shell path (example: command -v bash)." >&2
    exit 1
  fi
  echo "==> npm script shell: ${npm_shell}"
  npm_config_script_shell="$npm_shell" run_npm install -g "$SPEC"
  npm_prefix="$(run_npm prefix -g 2>/dev/null || true)"
  if [[ -n "${npm_prefix:-}" ]]; then
    GLOBAL_BIN_HINT="${npm_prefix}/bin"
  fi
fi

resolve_cli_bin() {
  local candidate hinted_path
  if [[ -n "$GLOBAL_BIN_HINT" ]]; then
    for candidate in openclaw moltbot; do
      hinted_path="${GLOBAL_BIN_HINT}/${candidate}"
      if [[ -x "$hinted_path" ]]; then
        printf '%s\n' "$hinted_path"
        return 0
      fi
    done
  fi

  if [[ -n "$OPENCLAW_BIN" ]]; then
    if command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
      command -v "$OPENCLAW_BIN"
      return 0
    fi
    echo "ERROR: OPENCLAW_BIN is set to '$OPENCLAW_BIN' but command was not found" >&2
    return 1
  fi

  for candidate in openclaw moltbot; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done

  echo "ERROR: could not find installed CLI command (tried: openclaw, moltbot)" >&2
  return 1
}

CLI_BIN_PATH="$(resolve_cli_bin)"
CLI_BIN_NAME="$(basename "$CLI_BIN_PATH")"

echo "==> Installed CLI: ${CLI_BIN_NAME} (${CLI_BIN_PATH})"
INSTALLED_VERSION="$("$CLI_BIN_PATH" --version 2>/dev/null || true)"
echo "==> Installed version: ${INSTALLED_VERSION:-unknown}"

# ── Phase 3: Onboarding ────────────────────────────────────────────────────

if [[ "$OPENCLAW_RUN_ONBOARD" == "1" ]]; then
  echo ""
  echo "============================================"
  echo "  Phase 3: OpenClaw Onboarding"
  echo "============================================"
  if [[ "$SAW_INSTALL" == "1" && -S "$SAW_SOCKET" ]]; then
    echo ""
    echo "  SAW is running. When prompted for x402 auth:"
    echo ""
    echo "    Socket path: $SAW_SOCKET"
    echo "    Wallet name: $SAW_WALLET"
    echo "    Sentinel:    saw:${SAW_WALLET}@${SAW_SOCKET}"
    echo ""
    echo "  Choose 'Secure Agent Wallet (SAW)' when asked"
    echo "  for the signing method."
  fi
  echo "============================================"
  echo ""
  export SAW_SOCKET
  # shellcheck disable=SC2086
  "$CLI_BIN_PATH" ${OPENCLAW_ONBOARD_ARGS}
else
  echo "==> Skipping onboarding (OPENCLAW_RUN_ONBOARD=${OPENCLAW_RUN_ONBOARD})"
  echo "    Run manually: ${CLI_BIN_PATH} ${OPENCLAW_ONBOARD_ARGS}"
  if [[ "$SAW_INSTALL" == "1" && -S "$SAW_SOCKET" ]]; then
    echo "    SAW sentinel: saw:${SAW_WALLET}@${SAW_SOCKET}"
  fi
fi
