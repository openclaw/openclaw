#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

if [[ -f "$HOME/.profile" ]]; then
  # Rehydrate user-level provider secrets for the transient systemd unit.
  # The review lane still uses its own config/state/workspace after this.
  # shellcheck disable=SC1090
  source "$HOME/.profile"
fi

if [[ -f "$SOURCE_STATE_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SOURCE_STATE_DIR/.env"
  set +a
fi

review_export_env
cd "$REPO_ROOT"

exec node openclaw.mjs gateway --port "$REVIEW_PORT" --bind loopback >>"$REVIEW_RUN_LOG" 2>&1
