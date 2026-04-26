#!/usr/bin/env bash

DOCKER_BUILD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! declare -F run_logged >/dev/null 2>&1; then
  source "$DOCKER_BUILD_LIB_DIR/docker-e2e-logs.sh"
fi

docker_build_exec() {
  local build_cmd=(docker build)
  if [ "${OPENCLAW_DOCKER_BUILD_USE_BUILDX:-0}" = "1" ]; then
    build_cmd=(docker buildx build --load)
    if [ -n "${OPENCLAW_DOCKER_BUILD_CACHE_FROM:-}" ]; then
      build_cmd+=(--cache-from "${OPENCLAW_DOCKER_BUILD_CACHE_FROM}")
    fi
    if [ -n "${OPENCLAW_DOCKER_BUILD_CACHE_TO:-}" ]; then
      build_cmd+=(--cache-to "${OPENCLAW_DOCKER_BUILD_CACHE_TO}")
    fi
  fi

  env DOCKER_BUILDKIT=1 "${build_cmd[@]}" "$@"
}

docker_build_run() {
  local label="$1"
  shift

  local build_cmd=(docker build)
  if [ "${OPENCLAW_DOCKER_BUILD_USE_BUILDX:-0}" = "1" ]; then
    build_cmd=(docker buildx build --load)
    if [ -n "${OPENCLAW_DOCKER_BUILD_CACHE_FROM:-}" ]; then
      build_cmd+=(--cache-from "${OPENCLAW_DOCKER_BUILD_CACHE_FROM}")
    fi
    if [ -n "${OPENCLAW_DOCKER_BUILD_CACHE_TO:-}" ]; then
      build_cmd+=(--cache-to "${OPENCLAW_DOCKER_BUILD_CACHE_TO}")
    fi
  fi

  run_logged "$label" env DOCKER_BUILDKIT=1 "${build_cmd[@]}" "$@"
}
