#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

# Direct callers use the same total envelope as CI; never restart an inherited budget.
CELL_DEADLINE_EPOCH_SECONDS="${CELL_DEADLINE_EPOCH_SECONDS:-$(( $(date +%s) + 1125 ))}"
if ! [[ "$CELL_DEADLINE_EPOCH_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid published-driver cell deadline" >&2
  exit 2
fi
export CELL_DEADLINE_EPOCH_SECONDS

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz published-driver-update "${1:-${OPENCLAW_CURRENT_PACKAGE_TGZ:-}}")"
RUNTIME_VOLUME=""
cleanup() {
  docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
  if [ -n "$RUNTIME_VOLUME" ]; then
    docker_e2e_docker_cmd volume rm "$RUNTIME_VOLUME" >/dev/null
  fi
}
trap cleanup EXIT
ARTIFACT_DIR="${2:-$ROOT_DIR/.artifacts/published-driver-update}"
DRIVER_TAG="${3:-latest}"
mkdir -p "$ARTIFACT_DIR"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"
printf 'prepare-container\n' > "$ARTIFACT_DIR/phase.txt"
# The shared image's disposable account owns these synthetic diagnostics.
chmod a+rwx "$ARTIFACT_DIR"
chmod a+rw "$ARTIFACT_DIR/phase.txt"
IMAGE_NAME="$(docker_e2e_resolve_image openclaw-published-driver-update-e2e)"
docker_e2e_build_or_reuse "$IMAGE_NAME" published-driver-update \
  "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" bare
docker_e2e_package_mount_args "$PACKAGE_TGZ"
# OverlayFS makes the published updater copy its entire retained runtime. Keep
# the disposable installation and retention tree on one native filesystem.
RUNTIME_VOLUME="$(docker_e2e_docker_cmd volume create)"
docker_e2e_run_with_harness \
  --init \
  -e CELL_DEADLINE_EPOCH_SECONDS \
  --mount "type=volume,source=$RUNTIME_VOLUME,target=/tmp" \
  -v "$ARTIFACT_DIR:/tmp/published-driver-artifacts" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  node scripts/e2e/lib/upgrade-survivor/published-driver.mjs \
    /tmp/openclaw-current.tgz /tmp/published-driver-artifacts "$DRIVER_TAG"
