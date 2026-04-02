#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/podman/setup.sh"

if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "Podman setup script not found at $SCRIPT_PATH" >&2
  exit 1
fi

exec "$SCRIPT_PATH" "$@"
