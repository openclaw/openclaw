#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

IMAGE_TAG="${IMAGE_TAG:-openclaw:local}"
DEFAULT_SERVICES=("openclaw-gateway")

NO_CACHE="false"
PULL="false"
SHOW_LOGS="false"
SERVICES=()

log() {
  printf '[update] %s\n' "$*"
}

die() {
  printf '[update][error] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/update.sh [options] [services...]

Options:
  --no-cache   Build image without cache
  --pull       Always attempt to pull newer base images
  --logs       Show service logs after update
  -h, --help   Show this help

Examples:
  ./scripts/update.sh
  ./scripts/update.sh openclaw-gateway openclaw-cli
  ./scripts/update.sh --no-cache --logs
  IMAGE_TAG=openclaw:dev ./scripts/update.sh --pull openclaw-gateway
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

while (($# > 0)); do
  case "$1" in
    --no-cache)
      NO_CACHE="true"
      shift
      ;;
    --pull)
      PULL="true"
      shift
      ;;
    --logs)
      SHOW_LOGS="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      SERVICES+=("$1")
      shift
      ;;
  esac
done

if [ ${#SERVICES[@]} -eq 0 ]; then
  SERVICES=("${DEFAULT_SERVICES[@]}")
fi

require_cmd docker

cd "$PROJECT_ROOT"

log "project root: $PROJECT_ROOT"
log "image tag: $IMAGE_TAG"
log "services: ${SERVICES[*]}"

docker info >/dev/null 2>&1 || die "docker daemon is not available"
[ -f "$PROJECT_ROOT/Dockerfile" ] || die "Dockerfile not found"
[ -f "$PROJECT_ROOT/docker-compose.yml" ] || die "docker-compose.yml not found"

BUILD_ARGS=(
  build
  -t "$IMAGE_TAG"
  -f "$PROJECT_ROOT/Dockerfile"
)

if [ "$NO_CACHE" = "true" ]; then
  BUILD_ARGS+=(--no-cache)
fi

if [ "$PULL" = "true" ]; then
  BUILD_ARGS+=(--pull)
fi

BUILD_ARGS+=("$PROJECT_ROOT")

log "building image..."
docker "${BUILD_ARGS[@]}"

log "recreating services..."
docker compose up -d --force-recreate "${SERVICES[@]}"

log "container status:"
docker compose ps

if [ "$SHOW_LOGS" = "true" ]; then
  log "showing recent logs..."
  docker compose logs --tail=100 "${SERVICES[@]}"
fi

log "update completed"
