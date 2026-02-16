#!/usr/bin/env bash
# Build and pin both OpenClaw and mux-server Docker images.
#
# Usage:
#   ./phala-deploy/build.sh                  # build + push both
#   ./phala-deploy/build.sh --no-push        # build only (no push, no digest pin)
#   ./phala-deploy/build.sh --dry-run        # print commands
#   ./phala-deploy/build.sh --mux-only       # mux-server image only
#   ./phala-deploy/build.sh --openclaw-only  # OpenClaw image only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUILD_OPENCLAW=1
BUILD_MUX=1
PASSTHROUGH_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --openclaw-only) BUILD_MUX=0; shift ;;
    --mux-only)      BUILD_OPENCLAW=0; shift ;;
    -h|--help)
      sed -n '2,/^[^#]/{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1"); shift ;;
  esac
done

log() { printf '\033[1;34m[build]\033[0m %s\n' "$*"; }

if [[ "$BUILD_OPENCLAW" -eq 1 ]]; then
  log "Building OpenClaw image..."
  "$SCRIPT_DIR/build-pin-image.sh" "${PASSTHROUGH_ARGS[@]}"
fi

if [[ "$BUILD_MUX" -eq 1 ]]; then
  log "Building mux-server image..."
  "$SCRIPT_DIR/build-pin-mux-image.sh" "${PASSTHROUGH_ARGS[@]}"
fi

log "Done."
