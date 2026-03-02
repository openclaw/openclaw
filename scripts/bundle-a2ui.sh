#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/bundle-a2ui.mjs"

if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT_PATH"
fi

if command -v node.exe >/dev/null 2>&1; then
  if command -v wslpath >/dev/null 2>&1; then
    node_exe_path="$(command -v node.exe)"
    script_windows_path="$(wslpath -w "$SCRIPT_PATH")"
    if command -v cmd.exe >/dev/null 2>&1; then
      windows_path="$(cmd.exe /c echo %PATH% | tr -d '\r')"
      if [[ -n "$windows_path" ]]; then
        export PATH="$windows_path"
      fi
    fi
    exec "$node_exe_path" "$script_windows_path"
  fi
  echo "wslpath is required to run node.exe from WSL." >&2
  exit 1
fi

echo "Node.js not found in PATH. Install Node 22+ to run A2UI bundling." >&2
exit 1
