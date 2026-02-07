#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_REPO="${PHALA_MUX_IMAGE_REPO:-h4x3rotab/openclaw-mux}"
IMAGE_TAG="${PHALA_MUX_IMAGE_TAG:-latest}"
COMPOSE_FILE="${PHALA_MUX_COMPOSE_FILE:-${SCRIPT_DIR}/mux-server-compose.yml}"
NO_PUSH=0
DRY_RUN=0

log() {
  printf '[build-pin-mux-image] %s\n' "$*"
}

die() {
  printf '[build-pin-mux-image] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [options]

Options:
  --image-repo <repo>     Docker image repo (default: h4x3rotab/openclaw-mux)
  --image-tag <tag>       Docker image tag (default: latest)
  --compose <path>        Compose file path (default: phala-deploy/mux-server-compose.yml)
  --no-push               Build image only (skip push and compose digest update)
  --dry-run               Print commands without executing
  -h, --help              Show this help

Environment:
  PHALA_MUX_IMAGE_REPO    Docker repo override
  PHALA_MUX_IMAGE_TAG     Docker tag override
  PHALA_MUX_COMPOSE_FILE  Compose file override

Examples:
  $(basename "$0")
  $(basename "$0") --image-repo your-user/openclaw-mux --image-tag 2026.2.13
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image-repo)
      IMAGE_REPO="${2:-}"
      shift 2
      ;;
    --image-tag)
      IMAGE_TAG="${2:-}"
      shift 2
      ;;
    --compose)
      COMPOSE_FILE="${2:-}"
      shift 2
      ;;
    --no-push)
      NO_PUSH=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

require_cmd docker
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

IMAGE_REF="${IMAGE_REPO}:${IMAGE_TAG}"

log "building Docker image: $IMAGE_REF"
run docker build -f "$ROOT_DIR/mux-server/Dockerfile" -t "$IMAGE_REF" "$ROOT_DIR"

if [[ "$NO_PUSH" -eq 0 ]]; then
  log "pushing Docker image: $IMAGE_REF"
  run docker push "$IMAGE_REF"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run: skipping digest inspection and compose update"
  exit 0
fi

if [[ "$NO_PUSH" -eq 1 ]]; then
  log "no-push: skipping digest inspection and compose update"
  exit 0
fi

DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_REF")"
[[ -n "$DIGEST" ]] || die "failed to resolve image digest"
log "resolved digest: $DIGEST"

TMP_FILE="$(mktemp)"
awk -v digest="$DIGEST" '
  BEGIN { in_mux = 0; updated = 0 }
  # Reset on every top-level service key, then re-enable within mux-server.
  # Order matters: the mux-server line matches both patterns.
  /^  [^[:space:]].*:/ { in_mux = 0 }
  /^  mux-server:/ { in_mux = 1 }
  {
    if (in_mux && !updated && $1 == "image:") {
      print "    image: " digest
      updated = 1
      next
    }
    print
  }
  END {
    if (!updated) {
      exit 10
    }
  }
' "$COMPOSE_FILE" > "$TMP_FILE" || {
  rm -f "$TMP_FILE"
  die "could not find mux-server image: line in $COMPOSE_FILE"
}

mv "$TMP_FILE" "$COMPOSE_FILE"
log "updated mux compose image digest in $COMPOSE_FILE"
