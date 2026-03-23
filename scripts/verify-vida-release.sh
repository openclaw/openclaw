#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify-vida-release.sh [--fork-tag <vida-vYYYY.M.D>] [--openclaw-ref <ref>] [--upstream-tag <vYYYY.M.D>] [--max-ahead-commits <n>] [--docker-dir <path>] [--skip-docker]

Defaults:
  --fork-tag      latest local tag matching vida-v*
  --openclaw-ref  same as --fork-tag
  --upstream-tag  derived from --fork-tag by stripping the vida- prefix
  --max-ahead-commits 25
  --docker-dir    ../openclaw-docker
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

FORK_TAG=""
OPENCLAW_REF=""
UPSTREAM_TAG=""
MAX_AHEAD_COMMITS=25
DOCKER_DIR="${REPO_ROOT}/../openclaw-docker"
SKIP_DOCKER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fork-tag)
      FORK_TAG="${2:-}"
      shift 2
      ;;
    --openclaw-ref)
      OPENCLAW_REF="${2:-}"
      shift 2
      ;;
    --upstream-tag)
      UPSTREAM_TAG="${2:-}"
      shift 2
      ;;
    --max-ahead-commits)
      MAX_AHEAD_COMMITS="${2:-}"
      shift 2
      ;;
    --docker-dir)
      DOCKER_DIR="${2:-}"
      shift 2
      ;;
    --skip-docker)
      SKIP_DOCKER=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: run this script inside the openclaw git repository." >&2
  exit 1
fi

if [[ -z "${FORK_TAG}" ]]; then
  FORK_TAG="$(git for-each-ref refs/tags --format='%(refname:short)' --sort=-creatordate | grep -E '^vida-v[0-9]' | head -n 1 || true)"
fi

if [[ -z "${FORK_TAG}" ]]; then
  echo "Error: could not resolve fork tag (expected something like vida-v2026.2.14)." >&2
  exit 1
fi

if [[ -z "${OPENCLAW_REF}" ]]; then
  OPENCLAW_REF="${FORK_TAG}"
fi

if [[ -z "${UPSTREAM_TAG}" ]]; then
  case "${FORK_TAG}" in
    vida-v*)
      UPSTREAM_TAG="${FORK_TAG#vida-}"
      ;;
  esac
fi

derive_image_tag() {
  local ref="$1"
  local parsed
  parsed="$(printf '%s' "${ref}" | sed -nE 's/^vida-v([0-9]{4})\.([0-9]{1,2})\.([0-9]{1,2})(.*)$/\1 \2 \3 \4/p')"
  if [[ -n "${parsed}" ]]; then
    # shellcheck disable=SC2086
    set -- ${parsed}
    local suffix="${4-}"
    printf '%04d-%02d-%02d%s\n' "$1" "$2" "$3" "${suffix}"
    return 0
  fi
  printf '%s\n' "$(printf '%s' "${ref}" | tr '/' '-')"
}

EXPECTED_IMAGE_TAG="$(derive_image_tag "${OPENCLAW_REF}")"

echo "Release verification inputs:"
echo "- fork tag: ${FORK_TAG}"
echo "- openclaw ref: ${OPENCLAW_REF}"
if [[ -n "${UPSTREAM_TAG}" ]]; then
  echo "- upstream tag: ${UPSTREAM_TAG}"
fi
echo "- expected docker tag: ${EXPECTED_IMAGE_TAG}"

if ! git rev-parse -q --verify "refs/tags/${FORK_TAG}" >/dev/null; then
  echo "Warning: local tag '${FORK_TAG}' not found."
fi

if ! git ls-remote --exit-code --tags --refs origin "${FORK_TAG}" >/dev/null 2>&1; then
  echo "Error: origin tag '${FORK_TAG}' not found. Push it first:" >&2
  echo "  git push origin ${FORK_TAG}" >&2
  exit 1
fi

if [[ -n "${UPSTREAM_TAG}" ]]; then
  if ! git rev-parse -q --verify "refs/tags/${UPSTREAM_TAG}" >/dev/null; then
    echo "Error: upstream tag '${UPSTREAM_TAG}' not found locally." >&2
    exit 1
  fi

  FORK_COMMIT="$(git rev-parse "refs/tags/${FORK_TAG}^{commit}")"
  UPSTREAM_COMMIT="$(git rev-parse "refs/tags/${UPSTREAM_TAG}^{commit}")"
  if ! git merge-base --is-ancestor "${UPSTREAM_COMMIT}" "${FORK_COMMIT}"; then
    echo "Error: fork tag '${FORK_TAG}' is not descended from upstream tag '${UPSTREAM_TAG}'." >&2
    exit 1
  fi

  AHEAD_COMMITS="$(git rev-list --count "${UPSTREAM_COMMIT}..${FORK_COMMIT}")"
  echo "- commits ahead of upstream tag: ${AHEAD_COMMITS}"
  if [[ "${AHEAD_COMMITS}" -gt "${MAX_AHEAD_COMMITS}" ]]; then
    echo "Error: fork tag '${FORK_TAG}' is ${AHEAD_COMMITS} commits ahead of '${UPSTREAM_TAG}' (max allowed ${MAX_AHEAD_COMMITS})." >&2
    echo "Top ahead commits:" >&2
    git log --oneline "${UPSTREAM_COMMIT}..${FORK_COMMIT}" | head -n 10 >&2
    exit 1
  fi
fi

if [[ "${SKIP_DOCKER}" -eq 1 ]]; then
  echo "Skipped docker compatibility checks (--skip-docker)."
  echo "Verification passed."
  exit 0
fi

if [[ ! -d "${DOCKER_DIR}" ]]; then
  echo "Error: docker dir not found: ${DOCKER_DIR}" >&2
  exit 1
fi

if [[ ! -f "${DOCKER_DIR}/Makefile" ]]; then
  echo "Error: docker Makefile not found: ${DOCKER_DIR}/Makefile" >&2
  exit 1
fi

build_preview="$(GH_TOKEN=dummy make -C "${DOCKER_DIR}" -n build OPENCLAW_REF="${OPENCLAW_REF}" 2>&1 || true)"
push_preview="$(GH_TOKEN=dummy make -C "${DOCKER_DIR}" -n push OPENCLAW_REF="${OPENCLAW_REF}" 2>&1 || true)"

check_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  if ! printf '%s\n' "${haystack}" | grep -Fq -- "${needle}"; then
    echo "Error: ${message}" >&2
    return 1
  fi
  return 0
}

check_contains "${build_preview}" "--build-arg OPENCLAW_GIT_REF=${OPENCLAW_REF}" "build preview missing expected OPENCLAW_REF"
check_contains "${build_preview}" "-t vidaislive/openclaw-docker:${EXPECTED_IMAGE_TAG}" "build preview missing expected image tag"
check_contains "${build_preview}" "--no-cache" "build preview missing --no-cache"

check_contains "${push_preview}" "--build-arg OPENCLAW_GIT_REF=${OPENCLAW_REF}" "push preview missing expected OPENCLAW_REF"
check_contains "${push_preview}" "-t vidaislive/openclaw-docker:${EXPECTED_IMAGE_TAG}" "push preview missing expected image tag"
check_contains "${push_preview}" "--no-cache" "push preview missing --no-cache"
check_contains "${push_preview}" "--push" "push preview missing --push"

echo "Verification passed."
