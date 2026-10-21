#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
MODE="${1:?expected deterministic or live}"
IMAGE_NAME="$(docker_e2e_resolve_image openclaw-muse-e2e OPENCLAW_MUSE_E2E_IMAGE)"
PACKAGE_TGZ="${OPENCLAW_CURRENT_PACKAGE_TGZ:-}"
CONTAINER="openclaw-muse-${MODE}-$$"
cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$PACKAGE_TGZ" ]; then docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"; fi
}
trap cleanup EXIT
docker_e2e_build_or_reuse "$IMAGE_NAME" muse-runtime "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" bare
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz muse-runtime "$PACKAGE_TGZ")"
docker_e2e_package_mount_args "$PACKAGE_TGZ"
AUTH="${OPENCLAW_MUSE_LIVE_AUTH:-api-key}"
if [ "$MODE" = live ]; then
  case "$AUTH" in device|api-key) ;; *) echo 'Expected OPENCLAW_MUSE_LIVE_AUTH=device or api-key' >&2; exit 1 ;; esac
  if [ "$AUTH" = api-key ] && [ -z "${OPENCLAW_MUSE_LIVE_KEY:-${META_API_KEY:-}}" ]; then
    echo 'Set META_API_KEY, OPENCLAW_MUSE_LIVE_KEY, or OPENCLAW_MUSE_LIVE_AUTH=device' >&2; exit 1
  fi
fi
docker_e2e_run_detached_with_harness --name "$CONTAINER" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -v "$ROOT_DIR/extensions/muse:/candidate/muse:ro" \
  -v "$ROOT_DIR/extensions/meta:/candidate/meta:ro" \
  -e "META_API_KEY=${OPENCLAW_MUSE_LIVE_KEY:-${META_API_KEY:-}}" \
  -e "OPENCLAW_MUSE_LIVE_AUTH=$AUTH" \
  -e OPENCLAW_STATE_DIR=/tmp/muse-state \
  -e OPENCLAW_CONFIG_PATH=/tmp/muse-state/openclaw.json \
  -e XDG_CONFIG_HOME=/tmp/muse-config -e TBH_CREDENTIAL_BACKEND=file \
  -e MUSE_NO_AUTO_UPDATE=1 -e MUSE_REQUEST_LOG=/tmp/muse-requests.jsonl \
  "$IMAGE_NAME" sleep infinity >/dev/null
if [ "$MODE" = live ]; then
  docker_e2e_docker_cmd exec --user root "$CONTAINER" bash -c 'apt-get update -qq && apt-get install -y --no-install-recommends curl'
fi
docker_e2e_docker_run_cmd exec "$CONTAINER" bash scripts/e2e/lib/muse-runtime/setup.sh "$MODE"
if [ "$MODE" = deterministic ]; then
  docker_e2e_docker_cmd network disconnect bridge "$CONTAINER"
fi
docker_e2e_docker_run_cmd exec "$CONTAINER" bash -c '
  export NPM_CONFIG_PREFIX="$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
  if [ "$1" = live ] && [ "$OPENCLAW_MUSE_LIVE_AUTH" = device ]; then unset META_API_KEY; fi
  if [ "$1" = deterministic ]; then export META_API_KEY=fixture-meta-key; fi
  root="$(npm root -g)/openclaw"
  node scripts/e2e/lib/muse-runtime/"$1".mjs "$root"
' bash "$MODE"
