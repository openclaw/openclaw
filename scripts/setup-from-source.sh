#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${OPENCLAW_REPO_URL:-https://github.com/aron98/openclaw.git}"
TARGET_DIR="${OPENCLAW_SRC_DIR:-openclaw}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd pnpm
require_cmd brew

is_repo_root() {
  if [[ ! -f "package.json" ]]; then
    return 1
  fi
  grep -q '"name"[[:space:]]*:[[:space:]]*"openclaw"' package.json
}

if ! is_repo_root; then
  if [[ -d "$TARGET_DIR" ]]; then
    cd "$TARGET_DIR"
  else
    git clone "$REPO_URL" "$TARGET_DIR"
    cd "$TARGET_DIR"
  fi
fi

pnpm install
pnpm ui:build
pnpm build

pnpm openclaw onboard --install-daemon

exec pnpm gateway:watch
