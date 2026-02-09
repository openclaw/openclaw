#!/usr/bin/env bash
set -euo pipefail

# Paths
OPENCLAW_WORKSPACE_DEFAULT="$HOME/.openclaw/workspace"
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$OPENCLAW_WORKSPACE_DEFAULT}"
SDK_REPO="${VEIL_SDK_REPO:-$OPENCLAW_WORKSPACE/repos/veildotcash-sdk}"
VEIL_DIR="$HOME/.clawdbot/skills/veil"
VEIL_ENV="$VEIL_DIR/.env.veil"
VEIL_ENV_EXTRA="$VEIL_DIR/.env"   # optional (RPC_URL, etc)
BANKR_CONFIG="$HOME/.clawdbot/skills/bankr/config.json"

need_bin() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required binary: $1" >&2; exit 1; }
}

# Check if global veil CLI is available (npm install -g @veil-cash/sdk)
has_global_veil() {
  command -v veil >/dev/null 2>&1
}

# Check if local SDK repo exists and is built
has_local_sdk() {
  [[ -d "$SDK_REPO" ]] && [[ -f "$SDK_REPO/dist/cli/index.cjs" ]]
}

ensure_sdk() {
  if has_global_veil || has_local_sdk; then
    return 0
  fi
  echo "Veil SDK not found. Install via one of:" >&2
  echo "  npm install -g @veil-cash/sdk" >&2
  echo "  OR clone & build: https://github.com/veildotcash/veildotcash-sdk" >&2
  exit 1
}

load_envs() {
  # Export variables from env files if present
  set -a
  [[ -f "$VEIL_ENV" ]] && source "$VEIL_ENV"
  [[ -f "$VEIL_ENV_EXTRA" ]] && source "$VEIL_ENV_EXTRA"
  set +a
}

veil_cli() {
  ensure_sdk
  load_envs
  # Prefer global veil CLI, fall back to local SDK repo
  if has_global_veil; then
    veil "$@"
  else
    node "$SDK_REPO/dist/cli/index.cjs" "$@"
  fi
}

ensure_veil_dir() {
  mkdir -p "$VEIL_DIR"
  chmod 700 "$VEIL_DIR" 2>/dev/null || true
}

ensure_veil_env_perms() {
  [[ -f "$VEIL_ENV" ]] && chmod 600 "$VEIL_ENV" 2>/dev/null || true
  [[ -f "$VEIL_ENV_EXTRA" ]] && chmod 600 "$VEIL_ENV_EXTRA" 2>/dev/null || true
}

need_bankr_config() {
  if [[ ! -f "$BANKR_CONFIG" ]]; then
    echo "Bankr config not found at: $BANKR_CONFIG" >&2
    echo "Create it with your Bankr API key (starts with bk_)." >&2
    exit 1
  fi
  need_bin jq
  need_bin curl
}
