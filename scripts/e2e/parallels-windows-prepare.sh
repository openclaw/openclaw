#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WINDOWS_NODE_REPO="${OPENCLAW_WINDOWS_NODE_REPO:-$ROOT_DIR/../openclaw-windows-node}"
CONTROLLER="$WINDOWS_NODE_REPO/scripts/parallels-windows-vm.sh"

if [[ ! -f "$CONTROLLER" ]]; then
  echo "error: Windows Parallels controller not found: $CONTROLLER" >&2
  echo "clone https://github.com/openclaw/openclaw-windows-node beside this repo or set OPENCLAW_WINDOWS_NODE_REPO" >&2
  exit 1
fi

exec bash "$CONTROLLER" "$@"
