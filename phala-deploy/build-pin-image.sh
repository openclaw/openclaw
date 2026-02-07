#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_REPO="${PHALA_IMAGE_REPO:-h4x3rotab/openclaw-cvm}"
IMAGE_TAG="${PHALA_IMAGE_TAG:-latest}"
COMPOSE_FILE="${PHALA_COMPOSE_FILE:-${SCRIPT_DIR}/docker-compose.yml}"
NO_BUILD=0
NO_UI_INSTALL=0
NO_PUSH=0
DRY_RUN=0

log() {
  printf '[build-pin-image] %s\n' "$*"
}

die() {
  printf '[build-pin-image] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [options]

Options:
  --image-repo <repo>     Docker image repo (default: h4x3rotab/openclaw-cvm)
  --image-tag <tag>       Docker image tag (default: latest)
  --compose <path>        Compose file path (default: phala-deploy/docker-compose.yml)
  --no-build              Skip pnpm build/ui/npm pack steps
  --no-ui-install         Skip pnpm ui:install (useful if already installed)
  --no-push               Build image only (skip push and compose digest update)
  --dry-run               Print commands without executing
  -h, --help              Show this help

Environment:
  PHALA_IMAGE_REPO        Docker repo override
  PHALA_IMAGE_TAG         Docker tag override
  PHALA_COMPOSE_FILE      Compose file override

Examples:
  $(basename "$0")
  $(basename "$0") --image-repo your-user/openclaw-cvm --image-tag 2026.2.12
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
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --no-ui-install)
      NO_UI_INSTALL=1
      shift
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
require_cmd pnpm
require_cmd npm
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

IMAGE_REF="${IMAGE_REPO}:${IMAGE_TAG}"

if [[ "$NO_BUILD" -eq 0 ]]; then
  log "building OpenClaw package tarball"
  run pnpm --dir "$ROOT_DIR" build
  if [[ "$NO_UI_INSTALL" -eq 0 ]]; then
    run pnpm --dir "$ROOT_DIR" ui:install
  fi
  run pnpm --dir "$ROOT_DIR" ui:build

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%q ' npm --prefix "$ROOT_DIR" pack --pack-destination "$SCRIPT_DIR"
    printf '\n'
    log "dry-run: skipping tarball creation"
  else
    PACK_OUT="$(npm --prefix "$ROOT_DIR" pack --pack-destination "$SCRIPT_DIR")"
    TGZ_NAME="$(printf '%s\n' "$PACK_OUT" | tail -n 1 | tr -d '[:space:]')"
    [[ -n "$TGZ_NAME" ]] || die "failed to resolve npm pack output"
    rm -f "$SCRIPT_DIR/openclaw.tgz"
    mv -f "$SCRIPT_DIR/$TGZ_NAME" "$SCRIPT_DIR/openclaw.tgz"
    log "updated tarball: $SCRIPT_DIR/openclaw.tgz"
  fi
fi

log "building Docker image: $IMAGE_REF"
run docker build -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE_REF" "$ROOT_DIR"

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
  BEGIN { updated = 0 }
  {
    if (!updated && $1 == "image:") {
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
  die "could not find image: line in $COMPOSE_FILE"
}

mv "$TMP_FILE" "$COMPOSE_FILE"
log "updated compose image digest in $COMPOSE_FILE"
