#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Published-baseline-to-candidate release user journey smoke.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/e2e/lib/release-scenarios/docker.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-release-upgrade-user-journey-e2e" OPENCLAW_RELEASE_UPGRADE_USER_JOURNEY_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_RELEASE_UPGRADE_USER_JOURNEY_E2E_SKIP_BUILD:-0}"
openclaw_release_prepare_docker release-upgrade-user-journey
DOCKER_ENV_ARGS=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64"
)
ARTIFACT_ROOT="${OPENCLAW_RELEASE_UPGRADE_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/release-upgrade-user-journey}"
mkdir -p "$ARTIFACT_ROOT"
ARTIFACT_DIR="$(mktemp -d "$ARTIFACT_ROOT/run.XXXXXX")"
chmod a+rwx "$ARTIFACT_DIR"
DOCKER_ENV_ARGS+=(
  -e OPENCLAW_RELEASE_UPGRADE_ARTIFACT_DIR=/tmp/release-upgrade-evidence
  -v "$(docker_e2e_abs_path "$ARTIFACT_DIR"):/tmp/release-upgrade-evidence"
)
if [ -n "${OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC:-}" ]; then
  DOCKER_ENV_ARGS+=(-e "OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC=$OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC")
fi

echo "Running release upgrade user journey Docker E2E..."
openclaw_release_run_docker \
  "${DOCKER_ENV_ARGS[@]}" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -i "$IMAGE_NAME" bash scripts/e2e/lib/release-upgrade-user-journey/scenario.sh

echo "Release upgrade user journey Docker E2E passed. Evidence: $ARTIFACT_DIR"
