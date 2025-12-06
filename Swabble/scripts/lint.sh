#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PEEKABOO_ROOT="${ROOT}/../peekaboo"
if [ -f "${PEEKABOO_ROOT}/.swiftlint.yml" ]; then
  CONFIG="${PEEKABOO_ROOT}/.swiftlint.yml"
else
  CONFIG="$ROOT/.swiftlint.yml"
fi
if ! command -v swiftlint >/dev/null; then
  echo "swiftlint not installed" >&2
  exit 1
fi
swiftlint --config "$CONFIG"
