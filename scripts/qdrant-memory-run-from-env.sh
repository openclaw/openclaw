#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${OPENCLAW_QDRANT_ENV_FILE:-$ROOT_DIR/qdrant-setup/qdrant-memory.env}"
RUNNER="$ROOT_DIR/scripts/qdrant-memory-index-if-due.sh"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

"$RUNNER"
