#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

RUN_ID="$(node -p 'require("node:crypto").randomUUID()')"
IMAGE_NAME="${OPENCLAW_CONTAINER_IMAGE_UPGRADE_IMAGE:-openclaw-container-image-upgrade:local}"
ARTIFACTS="$ROOT_DIR/.artifacts/docker-tests/container-image-upgrade-$RUN_ID"
mkdir -p "$ARTIFACTS"
CONTAINERS=()
ACTIVE_HELPER=""
VOLUMES=()
LABEL="org.openclaw.e2e.run"
cleanup() {
  local result=$?
  trap - EXIT
  local name owner
  if [ -n "$ACTIVE_HELPER" ]; then CONTAINERS+=("$ACTIVE_HELPER"); fi
  for name in "${CONTAINERS[@]}"; do
    if owner="$(docker_e2e_docker_cmd inspect -f "{{index .Config.Labels \"$LABEL\"}}" "$name" 2>/dev/null)"; then
      if [ "$owner" != "$RUN_ID" ]; then
        echo "Refusing cleanup of changed container $name" >&2
        result=1
        continue
      fi
      docker_e2e_docker_cmd logs "$name" >"$ARTIFACTS/$name.log" 2>&1 || true
      docker_e2e_docker_cmd inspect "$name" >"$ARTIFACTS/$name.inspect.json" || true
      docker_e2e_docker_cmd rm -f "$name" >/dev/null || result=1
    else
      echo "Container cleanup could not verify $name" >&2
      result=1
    fi
  done
  for name in "${VOLUMES[@]}"; do
    owner="$(docker_e2e_docker_cmd volume inspect -f "{{index .Labels \"$LABEL\"}}" "$name")" || { result=1; continue; }
    if [ "$owner" != "$RUN_ID" ]; then
      echo "Refusing cleanup of changed volume $name" >&2
      result=1
      continue
    fi
    docker_e2e_docker_cmd volume rm "$name" >/dev/null || result=1
  done
  echo "Container image activation evidence: $ARTIFACTS"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Root Dockerfile, not the bare/package E2E image: activation is the contract under test.
docker_e2e_build_or_reuse "$IMAGE_NAME" container-image-upgrade "$SOURCE_ROOT/Dockerfile" "$SOURCE_ROOT"
docker_e2e_docker_cmd image inspect "$IMAGE_NAME" >"$ARTIFACTS/image.json"
node "$ROOT_DIR/scripts/e2e/lib/container-image-upgrade/assert-launch.mjs" "$ARTIFACTS/image.json"
IMAGE_ID="$(docker_e2e_docker_cmd image inspect -f '{{.Id}}' "$IMAGE_NAME")"

for cell in default compose old-shape unsafe; do
  name="openclaw-image-upgrade-$RUN_ID-$cell"
  volume="$name-state"
  if docker_e2e_docker_cmd volume inspect "$volume" >/dev/null 2>&1; then
    echo "Refusing preexisting fixture volume $volume" >&2
    exit 1
  fi
  docker_e2e_docker_cmd volume create --label "$LABEL=$RUN_ID" "$volume" >/dev/null
  VOLUMES+=("$volume")
  mounts=(
    -v "$volume:/home/node/.openclaw"
    -v "$ROOT_DIR/scripts/e2e/lib/container-image-upgrade/fixture.mjs:/proof/scripts/e2e/lib/container-image-upgrade/fixture.mjs:ro"
    -v "$ROOT_DIR/scripts/lib/sqlite-transcript-payload.mjs:/proof/scripts/lib/sqlite-transcript-payload.mjs:ro"
    -v "$SOURCE_ROOT/test/fixtures/state-corpus/2026.9.2:/proof/state-corpus/2026.9.2:ro"
  )
  environment=(
    -e HOME=/home/node -e OPENCLAW_STATE_DIR=/home/node/.openclaw
    -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json
    -e "OPENCLAW_GATEWAY_TOKEN=synthetic-container-$RUN_ID"
    -e OPENCLAW_DISABLE_BONJOUR=1 -e OPENCLAW_DISABLE_BUNDLED_PLUGINS=1
  )
  # Generic helper commands keep the image entrypoint but do not invoke Doctor.
  helper="$name-seed"
  ACTIVE_HELPER="$helper"
  docker_e2e_docker_cmd run --rm --name "$helper" --label "$LABEL=$RUN_ID" \
    "${mounts[@]}" "${environment[@]}" "$IMAGE_ID" node /proof/scripts/e2e/lib/container-image-upgrade/fixture.mjs seed "$cell" \
    >"$ARTIFACTS/$cell-seed.json"
  ACTIVE_HELPER=""
  CONTAINERS+=("$name")
  case "$cell" in
    default | unsafe)
      docker_e2e_docker_cmd run -d --name "$name" --label "$LABEL=$RUN_ID" \
        "${mounts[@]}" "${environment[@]}" "$IMAGE_ID" >/dev/null ;;
    compose)
      docker_e2e_docker_cmd run -d --name "$name" --label "$LABEL=$RUN_ID" \
        "${mounts[@]}" "${environment[@]}" "$IMAGE_ID" \
        node dist/index.js gateway --bind lan --port 18789 >/dev/null ;;
    old-shape)
      # Counterfactual original04d0 activation shape on the final candidate image.
      # This is the sole entrypoint override, not a separately built baseline image.
      docker_e2e_docker_cmd run -d --name "$name" --label "$LABEL=$RUN_ID" \
        "${mounts[@]}" "${environment[@]}" --entrypoint tini "$IMAGE_ID" \
        -s -- node openclaw.mjs gateway >/dev/null ;;
  esac
  if [ "$cell" = default ] || [ "$cell" = compose ]; then
    docker_e2e_wait_container_bash "$name" 180 1 'node /proof/scripts/e2e/lib/container-image-upgrade/fixture.mjs ready'
    docker_e2e_docker_cmd exec "$name" node /proof/scripts/e2e/lib/container-image-upgrade/fixture.mjs ready >"$ARTIFACTS/$cell-ready.json"
    docker_e2e_docker_cmd exec "$name" node /proof/scripts/e2e/lib/container-image-upgrade/fixture.mjs history >"$ARTIFACTS/$cell-history.json"
    docker_e2e_docker_cmd inspect "$name" >"$ARTIFACTS/$cell-launch.json"
    node "$ROOT_DIR/scripts/e2e/lib/container-image-upgrade/assert-launch.mjs" \
      "$ARTIFACTS/image.json" "$ARTIFACTS/$cell-launch.json" "$cell"
    docker_e2e_docker_cmd stop --time 60 "$name" >/dev/null
    docker_e2e_docker_cmd inspect "$name" >"$ARTIFACTS/$cell-stop.json"
    node "$ROOT_DIR/scripts/e2e/lib/container-image-upgrade/assert-launch.mjs" \
      "$ARTIFACTS/image.json" "$ARTIFACTS/$cell-stop.json" "$cell" "" stopped \
      >"$ARTIFACTS/$cell-stop-assertion.json"
    verify=migrated
  else
    # Require a natural refusal, not a timeout kill. Poll readiness while it can run.
    for attempt in $(seq 1 180); do
      if ! docker_e2e_container_running "$name"; then break; fi
      if docker_e2e_docker_cmd exec "$name" node /proof/scripts/e2e/lib/container-image-upgrade/fixture.mjs ready >/dev/null 2>&1; then
        echo "Refusal control unexpectedly became ready: $cell" >&2
        exit 1
      fi
      sleep 1
    done
    docker_e2e_docker_cmd logs "$name" >"$ARTIFACTS/$cell-refusal.log" 2>&1
    docker_e2e_docker_cmd inspect "$name" >"$ARTIFACTS/$cell-launch.json"
    node "$ROOT_DIR/scripts/e2e/lib/container-image-upgrade/assert-launch.mjs" \
      "$ARTIFACTS/image.json" "$ARTIFACTS/$cell-launch.json" "$cell" "$ARTIFACTS/$cell-refusal.log"
    verify="$cell"
  fi
  helper="$name-verify"
  ACTIVE_HELPER="$helper"
  docker_e2e_docker_cmd run --rm --name "$helper" --label "$LABEL=$RUN_ID" \
    "${mounts[@]}" "${environment[@]}" "$IMAGE_ID" node /proof/scripts/e2e/lib/container-image-upgrade/fixture.mjs verify "$verify" \
    >"$ARTIFACTS/$cell-state.json"
  ACTIVE_HELPER=""
  echo "Container image activation passed: $cell"
done
