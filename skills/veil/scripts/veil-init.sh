#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

ensure_veil_dir
ensure_sdk

if [[ -f "$VEIL_ENV" ]]; then
  echo "Veil env already exists: $VEIL_ENV" >&2
  echo "(delete it to regenerate)" >&2
  exit 0
fi

# Generate directly into skill env path
node "$SDK_REPO/dist/cli/index.cjs" init --out "$VEIL_ENV"
chmod 600 "$VEIL_ENV"

echo "Wrote: $VEIL_ENV" >&2
