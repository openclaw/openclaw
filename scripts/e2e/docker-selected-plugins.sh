#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-build.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

IMAGE_NAME="${OPENCLAW_DOCKER_SELECTED_PLUGINS_E2E_IMAGE:-openclaw-docker-selected-plugins-e2e:local}"
DEPENDENCY_ONLY_IMAGE="${IMAGE_NAME}-dependency-only"
CONTAINER_NAME="openclaw-docker-selected-plugins-e2e-$$"
SELECTED_PLUGINS="${OPENCLAW_DOCKER_SELECTED_PLUGINS:-slack,msteams clickclack,slack}"
UNKNOWN_LOG="$(mktemp -t openclaw-docker-selected-plugins-unknown.XXXXXX)"
RUN_LOG="$(mktemp -t openclaw-docker-selected-plugins-run.XXXXXX)"
DOCKER_COMMAND_TIMEOUT="${OPENCLAW_DOCKER_SELECTED_PLUGINS_RUN_TIMEOUT:-900s}"
DEPENDENCY_ONLY_IMAGE_BUILT=0

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [ "$DEPENDENCY_ONLY_IMAGE_BUILT" = "1" ]; then
    docker_e2e_docker_cmd image rm -f "$DEPENDENCY_ONLY_IMAGE" >/dev/null 2>&1 || true
  fi
  rm -f "$UNKNOWN_LOG" "$RUN_LOG"
}
trap cleanup EXIT

if [ "${OPENCLAW_SKIP_DOCKER_BUILD:-0}" = "1" ]; then
  echo "Reusing selected-plugin image: $IMAGE_NAME"
  docker_e2e_docker_cmd image inspect "$IMAGE_NAME" >/dev/null
else
  echo "Proving unknown selected plugins fail closed..."
  set +e
  docker_e2e_timeout_cmd "${OPENCLAW_DOCKER_SELECTED_PLUGINS_BUILD_TIMEOUT:-3600s}" \
    env DOCKER_BUILDKIT=1 docker build \
    --target workspace-deps \
    --build-arg OPENCLAW_EXTENSIONS=missing-plugin \
    -f "$ROOT_DIR/Dockerfile" \
    "$ROOT_DIR" >"$UNKNOWN_LOG" 2>&1
  unknown_status=$?
  set -e
  if [ "$unknown_status" -eq 0 ] || ! grep -Fq \
    "unknown OPENCLAW_EXTENSIONS plugin id: missing-plugin" "$UNKNOWN_LOG"; then
    echo "Unknown selected-plugin build did not fail closed as expected" >&2
    docker_e2e_print_log "$UNKNOWN_LOG"
    exit 1
  fi

  echo "Proving known dependency-only selected plugins remain stageable..."
  docker_build_run docker-selected-plugins-dependency-only \
    --target workspace-deps \
    --build-arg OPENCLAW_EXTENSIONS=whatsapp,qqbot \
    -t "$DEPENDENCY_ONLY_IMAGE" \
    -f "$ROOT_DIR/Dockerfile" \
    "$ROOT_DIR"
  DEPENDENCY_ONLY_IMAGE_BUILT=1
  docker_e2e_docker_run_cmd run --rm \
    --entrypoint sh \
    "$DEPENDENCY_ONLY_IMAGE" \
    -c 'test -f /out/extensions/whatsapp/package.json && test -f /out/extensions/qqbot/package.json'

  echo "Building selected-plugin runtime image: $IMAGE_NAME"
  docker_build_run docker-selected-plugins-build \
    --build-arg "OPENCLAW_EXTENSIONS=$SELECTED_PLUGINS" \
    -t "$IMAGE_NAME" \
    -f "$ROOT_DIR/Dockerfile" \
    "$ROOT_DIR"
fi

echo "Inspecting selected plugins from the final runtime image..."
if ! docker_e2e_docker_run_cmd run --rm \
  --name "$CONTAINER_NAME" \
  --entrypoint bash \
  -v "$ROOT_DIR/scripts/e2e/lib/docker-selected-plugins:/openclaw-e2e:ro" \
  "$IMAGE_NAME" \
  /openclaw-e2e/scenario.sh >"$RUN_LOG" 2>&1; then
  echo "Selected-plugin Docker E2E failed" >&2
  docker_e2e_print_log "$RUN_LOG"
  exit 1
fi

docker_e2e_print_log "$RUN_LOG"
echo "Selected-plugin Docker E2E passed"
