#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Package-installed media and memory release smoke.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/e2e/lib/release-scenarios/docker.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-release-media-memory-e2e" OPENCLAW_RELEASE_MEDIA_MEMORY_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_RELEASE_MEDIA_MEMORY_E2E_SKIP_BUILD:-0}"
openclaw_release_prepare_docker release-media-memory
echo "Running release media memory Docker E2E..."
openclaw_release_run_docker \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -i "$IMAGE_NAME" bash scripts/e2e/lib/release-media-memory/scenario.sh

echo "Release media memory Docker E2E passed."
