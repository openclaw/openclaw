#!/usr/bin/env bash
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
FUNCTIONAL_IMAGE="$(docker_e2e_resolve_image "openclaw-mcp-docker-custody-functional:local" OPENCLAW_MCP_DOCKER_CUSTODY_IMAGE)"
RUNNER_IMAGE="openclaw-mcp-docker-custody-runner:${OPENCLAW_DOCKER_ALL_LANE_NAME:-local}"
FIXTURE_IMAGE="node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d"
DOCKER_SOCKET="${OPENCLAW_DOCKER_SOCKET:-/var/run/docker.sock}"
SCENARIO_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-mcp-docker-custody.XXXXXX")"
RUN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
CONTAINER_NAME="openclaw-mcp-docker-custody-$RUN_ID"

cleanup() {
  local container_id
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  while IFS= read -r container_id; do
    [ -z "$container_id" ] || docker_e2e_docker_cmd rm -f "$container_id" >/dev/null 2>&1 || true
  done < <(docker_e2e_docker_cmd ps -aq --no-trunc --filter "label=openclaw.test.mcp-custody=$RUN_ID")
  docker_e2e_docker_cmd run --rm --user 0:0 -v "$SCENARIO_ROOT:/target" "$FIXTURE_IMAGE" \
    sh -c 'rm -rf /target/* /target/.[!.]* /target/..?*' >/dev/null 2>&1 || true
  rm -rf "$SCENARIO_ROOT"
}
trap cleanup EXIT

[ -S "$DOCKER_SOCKET" ] || { echo "Docker socket not found: $DOCKER_SOCKET" >&2; exit 1; }
docker_e2e_build_or_reuse "$FUNCTIONAL_IMAGE" mcp-docker-custody
docker_e2e_docker_cmd pull "$FIXTURE_IMAGE"
docker_e2e_docker_cmd run --rm "$FIXTURE_IMAGE" true
# Desktop Docker engines can project a different socket GID than the host sees.
SOCKET_GID="$(docker_e2e_docker_cmd run --rm \
  --label "openclaw.test.mcp-custody=$RUN_ID" \
  -v "$DOCKER_SOCKET:/var/run/docker.sock" "$FIXTURE_IMAGE" \
  stat -c '%g' /var/run/docker.sock)"

cat >"$SCENARIO_ROOT/Dockerfile" <<'EOF'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io docker-cli \
 && rm -rf /var/lib/apt/lists/*
USER appuser
EOF
docker_build_run mcp-docker-custody-runner \
  --build-arg "BASE_IMAGE=$FUNCTIONAL_IMAGE" -t "$RUNNER_IMAGE" \
  -f "$SCENARIO_ROOT/Dockerfile" "$SCENARIO_ROOT"
cp "$ROOT_DIR/scripts/e2e/lib/mcp-docker-custody/server.cjs" "$SCENARIO_ROOT/server.cjs"
chmod 0777 "$SCENARIO_ROOT"

# Nested Docker resolves bind sources on the host. Use this one task root at the
# same path in both containers; the installed app and its dependencies stay /app.
docker_e2e_run_logged_print_with_harness mcp-docker-custody \
  --name "$CONTAINER_NAME" \
  --group-add "$SOCKET_GID" \
  -e "OPENCLAW_MCP_CUSTODY_ROOT=$SCENARIO_ROOT" \
  -e "OPENCLAW_MCP_CUSTODY_RUN_ID=$RUN_ID" \
  -e "OPENCLAW_MCP_CUSTODY_IMAGE=$FIXTURE_IMAGE" \
  -v "$DOCKER_SOCKET:/var/run/docker.sock" \
  -v "$SCENARIO_ROOT:$SCENARIO_ROOT" \
  -v "$ROOT_DIR/scripts/e2e/lib/mcp-docker-custody/scenario.mjs:/tmp/mcp-docker-custody-scenario.mjs:ro" \
  "$RUNNER_IMAGE" node /tmp/mcp-docker-custody-scenario.mjs
