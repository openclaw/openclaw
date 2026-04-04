#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOLVER="${ROOT_DIR}/scripts/resolve-xcode-developer-dir.sh"

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/with-xcode-developer-dir.sh <command> [args...]" >&2
  exit 1
fi

if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  resolved_dir="$("${RESOLVER}" 2>/dev/null || true)"
  if [[ -n "${resolved_dir}" ]]; then
    export DEVELOPER_DIR="${resolved_dir}"
  fi
fi

exec "$@"
