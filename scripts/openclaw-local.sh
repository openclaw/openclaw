#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
NODE="${OPENCLAW_NODE_BIN:-$(command -v node)}"
CLI="$ROOT/openclaw.mjs"
PREFLIGHT="$ROOT/scripts/local-runtime-preflight.sh"
LOCAL_RESTART="$ROOT/scripts/restart-local-gateway.sh"

if [[ ! -x "$NODE" ]]; then
  echo "ERROR: node runtime not found. Install Node 22+ or set OPENCLAW_NODE_BIN." >&2
  exit 1
fi

if [[ -x "$PREFLIGHT" ]]; then
  "$PREFLIGHT" --quiet
fi

if [[ -x "$LOCAL_RESTART" ]]; then
  export OPENCLAW_LOCAL_RESTART_SCRIPT="${OPENCLAW_LOCAL_RESTART_SCRIPT:-$LOCAL_RESTART}"
fi

# Hard-pin restart commands to the local fork service script.
if [[ "${OPENCLAW_USE_LOCAL_RESTART_SCRIPT:-1}" != "0" && -x "$LOCAL_RESTART" ]]; then
  if [[ $# -eq 1 && "$1" == "restart" ]]; then
    exec "$LOCAL_RESTART"
  fi
  if [[ $# -eq 2 ]]; then
    case "$1:$2" in
      gateway:restart|daemon:restart)
        exec "$LOCAL_RESTART"
        ;;
    esac
  fi
fi

exec "$NODE" "$CLI" "$@"
