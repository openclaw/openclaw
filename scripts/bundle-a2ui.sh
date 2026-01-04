#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HASH_FILE="$ROOT_DIR/src/canvas-host/a2ui/.bundle.hash"

INPUT_PATHS=(
  "$ROOT_DIR/package.json"
  "$ROOT_DIR/pnpm-lock.yaml"
  "$ROOT_DIR/vendor/a2ui/renderers/lit"
  "$ROOT_DIR/apps/shared/ClawdbotKit/Tools/CanvasA2UI"
)

collect_files() {
  local path
  for path in "${INPUT_PATHS[@]}"; do
    if [[ -d "$path" ]]; then
      find "$path" -type f -print0
    else
      printf '%s\0' "$path"
    fi
  done
}

compute_hash() {
  collect_files \
    | LC_ALL=C sort -z \
    | xargs -0 shasum -a 256 \
    | shasum -a 256 \
    | awk '{print $1}'
}

current_hash="$(compute_hash)"
if [[ -f "$HASH_FILE" ]]; then
  previous_hash="$(cat "$HASH_FILE")"
  if [[ "$previous_hash" == "$current_hash" ]]; then
    echo "A2UI bundle up to date; skipping."
    exit 0
  fi
fi

pnpm -s exec tsc -p vendor/a2ui/renderers/lit/tsconfig.json
rolldown -c apps/shared/ClawdbotKit/Tools/CanvasA2UI/rolldown.config.mjs

echo "$current_hash" > "$HASH_FILE"
