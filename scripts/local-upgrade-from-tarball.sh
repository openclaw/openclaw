#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/local-upgrade-from-tarball.sh [--pack-dir DIR] [--tarball FILE] [--skip-regression]

Build a local OpenClaw tarball from the current repo, install it globally, verify
that the global install no longer points at /tmp, then run the live memory-pro
host regression.

Environment overrides:
  OPENCLAW_LOCAL_PACK_DIR   Stable directory for generated tarballs
  OPENCLAW_TARBALL          Prebuilt tarball to install instead of running npm pack
  OPENCLAW_BIN              OpenClaw binary name/path used by the regression script
EOF
}

require_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: $name" >&2
    exit 1
  fi
}

resolve_realpath() {
  node -e 'const fs=require("fs"); process.stdout.write(fs.realpathSync(process.argv[1]));' "$1"
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PACK_DIR="${OPENCLAW_LOCAL_PACK_DIR:-$REPO_ROOT/tmp/openclaw-packages}"
TARBALL_PATH="${OPENCLAW_TARBALL:-}"
RUN_REGRESSION=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pack-dir)
      PACK_DIR="$2"
      shift 2
      ;;
    --tarball)
      TARBALL_PATH="$2"
      shift 2
      ;;
    --skip-regression)
      RUN_REGRESSION=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_cmd npm
require_cmd node
require_cmd openclaw

mkdir -p "$PACK_DIR"

if [[ -z "$TARBALL_PATH" ]]; then
  echo "[1/5] Packing OpenClaw tarball into $PACK_DIR"
  if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [[ -n "$(git -C "$REPO_ROOT" status --short)" ]]; then
      echo "Notice: packing a dirty working tree from $REPO_ROOT" >&2
    fi
  fi
  npm pack "$REPO_ROOT" --pack-destination "$PACK_DIR" >/dev/null
  TARBALL_PATH="$(ls -t "$PACK_DIR"/openclaw-*.tgz | head -n 1)"
fi

if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "Tarball not found: $TARBALL_PATH" >&2
  exit 1
fi

echo "[2/5] Installing $TARBALL_PATH globally"
npm install -g "$TARBALL_PATH"

GLOBAL_PREFIX="$(npm prefix -g)"
INSTALL_DIR="$GLOBAL_PREFIX/lib/node_modules/openclaw"
BIN_PATH="$GLOBAL_PREFIX/bin/openclaw"

if [[ ! -e "$INSTALL_DIR/package.json" ]]; then
  echo "Global install missing package.json at $INSTALL_DIR" >&2
  exit 1
fi

echo "[3/5] Verifying global install path"
if [[ -L "$INSTALL_DIR" ]]; then
  echo "Global install is still a symlink: $INSTALL_DIR -> $(readlink "$INSTALL_DIR")" >&2
  exit 1
fi

INSTALL_REALPATH="$(resolve_realpath "$INSTALL_DIR")"
if [[ "$INSTALL_REALPATH" == /tmp/* || "$INSTALL_REALPATH" == /private/tmp/* ]]; then
  echo "Global install still resolves into tmp: $INSTALL_REALPATH" >&2
  exit 1
fi

PACKAGE_BIN="$(node -p "require('$INSTALL_DIR/package.json').bin.openclaw")"
if [[ "$PACKAGE_BIN" != "scripts/openclaw-runcli-launcher.mjs" ]]; then
  echo "Unexpected package bin entry: $PACKAGE_BIN" >&2
  exit 1
fi

if [[ ! -e "$BIN_PATH" ]]; then
  echo "Global openclaw bin missing: $BIN_PATH" >&2
  exit 1
fi

BIN_REALPATH="$(resolve_realpath "$BIN_PATH")"
EXPECTED_BIN_REALPATH="$(resolve_realpath "$INSTALL_DIR/scripts/openclaw-runcli-launcher.mjs")"
if [[ "$BIN_REALPATH" != "$EXPECTED_BIN_REALPATH" ]]; then
  echo "Global openclaw bin does not resolve to launcher" >&2
  echo "  actual:   $BIN_REALPATH" >&2
  echo "  expected: $EXPECTED_BIN_REALPATH" >&2
  exit 1
fi

echo "[4/5] Verifying installed CLI version"
openclaw --version

if [[ "$RUN_REGRESSION" -eq 1 ]]; then
  echo "[5/5] Running live memory-pro host regression"
  node "$REPO_ROOT/scripts/test-live-memory-pro-cli-host.mjs"
else
  echo "[5/5] Skipped live memory-pro host regression"
fi
