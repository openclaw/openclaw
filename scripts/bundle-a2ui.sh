#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/bundle-a2ui.mjs"

# True when the shell is running inside WSL (not native Git Bash / MSYS).
is_wsl() {
  if [[ -n "${WSL_DISTRO_NAME:-}" ]] || [[ -n "${WSL_INTEROP:-}" ]]; then
    return 0
  fi
  if [[ -f /proc/sys/fs/binfmt_misc/WSLInterop ]]; then
    return 0
  fi
  if [[ -r /proc/version ]] && grep -qi microsoft /proc/version 2>/dev/null; then
    return 0
  fi
  return 1
}

run_windows_node() {
  local node_bin="$1"
  if command -v wslpath >/dev/null 2>&1; then
    local script_windows_path windows_path
    script_windows_path="$(wslpath -w "$SCRIPT_PATH")"
    if command -v cmd.exe >/dev/null 2>&1; then
      windows_path="$(cmd.exe /c echo %PATH% | tr -d '\r')"
      if [[ -n "$windows_path" ]]; then
        export PATH="$windows_path"
      fi
    fi
    exec "$node_bin" "$script_windows_path"
  fi
  if is_wsl; then
    echo "wslpath is required to run Windows Node.js from WSL (convert script path for node.exe)." >&2
    exit 1
  fi
  # Git Bash / MSYS: node.exe accepts Unix-style paths from the shell; no wslpath there.
  exec "$node_bin" "$SCRIPT_PATH"
}

if command -v node >/dev/null 2>&1; then
  node_path="$(command -v node)"
  if [[ "$node_path" == *.exe ]]; then
    run_windows_node "$node_path"
  fi
  exec "$node_path" "$SCRIPT_PATH"
fi

if command -v node.exe >/dev/null 2>&1; then
  run_windows_node "$(command -v node.exe)"
fi

echo "Node.js not found in PATH. Install Node 22+ to run A2UI bundling." >&2
exit 1
