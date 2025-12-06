#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PEEKABOO_ROOT="${ROOT}/../peekaboo"
if [ -f "${PEEKABOO_ROOT}/.swiftformat" ]; then
  CONFIG="${PEEKABOO_ROOT}/.swiftformat"
else
  CONFIG="${ROOT}/.swiftformat"
fi
swiftformat --config "$CONFIG" "$ROOT/Sources"
