#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-build.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
IMAGE_NAME="${OPENCLAW_CLEANUP_SMOKE_IMAGE:-openclaw-cleanup-smoke:local}"
DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_CLEANUP_SMOKE_DOCKER_TIMEOUT:-600s}}"

PLATFORM="$(docker_build_resolve_platform "${OPENCLAW_CLEANUP_SMOKE_PLATFORM:-}")"

echo "==> Build image: $IMAGE_NAME"
docker_build_run cleanup-build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/cleanup-smoke/Dockerfile" \
  "$ROOT_DIR"

echo "==> Run cleanup smoke test"
limit_summary=""
limit_args=(-e GITHUB_ACTIONS)
cleanup_limit_summary() {
  local command_exit="$?"
  if [[ -n "$limit_summary" ]]; then
    cat "$limit_summary" >> "$GITHUB_STEP_SUMMARY"
    rm -f "$limit_summary"
  fi
  return "$command_exit"
}
trap cleanup_limit_summary EXIT
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  limit_summary="$(mktemp "${TMPDIR:-/tmp}/openclaw-cleanup-limits.XXXXXX")"
  chmod 0666 "$limit_summary"
  limit_args+=(-e GITHUB_STEP_SUMMARY=/tmp/openclaw-limit-summary.md -v "$limit_summary:/tmp/openclaw-limit-summary.md")
fi
docker_e2e_docker_run_cmd run --rm --platform "$PLATFORM" -t "${limit_args[@]}" "$IMAGE_NAME"
