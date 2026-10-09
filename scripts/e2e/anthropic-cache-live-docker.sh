#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

if [[ "$#" -gt 1 || ( "$#" -eq 1 && "$1" != "--mock" ) ]]; then
  echo "Usage: $0 [--mock]" >&2
  exit 1
fi
if [[ "${1:-}" != "--mock" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY is required for the live Anthropic cache regression." >&2
  exit 1
fi

IMAGE_NAME="$(docker_e2e_resolve_image openclaw-anthropic-cache-live-e2e OPENCLAW_ANTHROPIC_CACHE_LIVE_IMAGE)"
docker_e2e_build_or_reuse "$IMAGE_NAME" anthropic-cache-live

# Only harness scripts are mounted; both Anthropic builders come from the
# candidate package installed in /app. Native Node bypasses source path aliases.
docker_e2e_run_with_harness \
  -e ANTHROPIC_API_KEY \
  "$IMAGE_NAME" \
  node scripts/e2e/anthropic-cache-live.mts "$@"
