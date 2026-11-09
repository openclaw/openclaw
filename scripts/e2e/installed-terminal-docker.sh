#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

PACKAGE_TGZ=""
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$PACKAGE_TGZ" ]; then
    if ! docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"; then
      [ "$status" -ne 0 ] || status=1
    fi
  fi
  if [ "$status" -ne 0 ]; then
    printf '[installed-terminal] FAILED (exit %s)\n' "$status" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

CELL_DEADLINE_EPOCH_SECONDS="${CELL_DEADLINE_EPOCH_SECONDS:-$(( $(date +%s) + 2700 ))}"
[[ "$CELL_DEADLINE_EPOCH_SECONDS" =~ ^[1-9][0-9]*$ ]] || exit 2
export CELL_DEADLINE_EPOCH_SECONDS
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
if [ -z "${DOCKER_E2E_CONTAINER_CIDFILE:-}" ]; then
  echo 'Use node scripts/test-docker-all.mjs --lanes=installed-terminal for bounded producer settlement' >&2
  exit 2
fi

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz installed-terminal "${1:-${OPENCLAW_CURRENT_PACKAGE_TGZ:-}}")"
ARTIFACT_DIR="${2:-${OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/installed-terminal}}"
mkdir -p "$ARTIFACT_DIR"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"
# Share only this synthetic evidence directory with the container's supplementary
# group. The existing evidence writer preserves group reads without public access.
chmod 2770 "$ARTIFACT_DIR"
(
  cd "$ROOT_DIR"
  node --import tsx scripts/e2e/lib/upgrade-survivor/installed-terminal-reference.mts \
    package "$PACKAGE_TGZ" "$ARTIFACT_DIR/installed-terminal-contracts.json"
)
chmod 0640 "$ARTIFACT_DIR/installed-terminal-contracts.json"
IMAGE_NAME="$(docker_e2e_resolve_image openclaw-installed-terminal-e2e)"
docker_e2e_build_or_reuse "$IMAGE_NAME" installed-terminal \
  "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" bare
docker_e2e_package_mount_args "$PACKAGE_TGZ"
fixture_root="${DOCKER_E2E_HARNESS_ROOT_DIR:-$ROOT_DIR}"
status=0
docker_e2e_run_with_harness \
  --init --group-add "$(id -g)" \
  -e CELL_DEADLINE_EPOCH_SECONDS -e OPENCLAW_DOCKER_E2E_SELECTED_SHA \
  -v "$fixture_root/test/fixtures/sqlite/openclaw-agent-schema-v25.sql:/app/test/fixtures/sqlite/openclaw-agent-schema-v25.sql:ro" \
  -v "$ARTIFACT_DIR:/tmp/installed-terminal-artifacts" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" "$IMAGE_NAME" \
  node scripts/e2e/lib/upgrade-survivor/installed-terminal.mjs \
    /tmp/openclaw-current.tgz /tmp/installed-terminal-artifacts \
    /tmp/installed-terminal-artifacts/installed-terminal-contracts.json || status=$?
# The scheduler independently settles its host-owned CID after this group joins,
# including signal exits that cannot reach this point.
exit "$status"
