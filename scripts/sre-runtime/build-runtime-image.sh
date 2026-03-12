#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
MORPHO_ROOT="${OPENCLAW_SRE_MORPHO_ROOT:-$(cd -- "${REPO_ROOT}/.." && pwd)}"
IMAGE_NAME="${OPENCLAW_SRE_IMAGE_NAME:-openclaw-sre:local}"
BUILD_PLATFORM="${OPENCLAW_SRE_BUILD_PLATFORM:-}"
PUSH_IMAGE="${OPENCLAW_SRE_PUSH:-0}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-sre-image.XXXXXX")"
trap 'chmod -R u+w "$TMP_DIR" 2>/dev/null || true; rm -rf "$TMP_DIR" || true' EXIT

copy_repo() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest"
  tar \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.build-context' \
    --exclude='coverage' \
    --exclude='.turbo' \
    --exclude='.pnpm-store' \
    -C "$src" \
    -cf - . | tar -C "$dest" -xf -
}

command -v docker >/dev/null 2>&1 || {
  echo "missing required command: docker" >&2
  exit 1
}
command -v pnpm >/dev/null 2>&1 || {
  echo "missing required command: pnpm" >&2
  exit 1
}

copy_repo "$REPO_ROOT" "$TMP_DIR/openclaw-sre"
copy_repo "${MORPHO_ROOT}/morpho-infra" "$TMP_DIR/morpho-infra"
copy_repo "${MORPHO_ROOT}/morpho-infra-helm" "$TMP_DIR/morpho-infra-helm"

PACK_OUTPUT="$(cd "$REPO_ROOT" && pnpm pack --pack-destination "$TMP_DIR")"
PACK_FILE="$(printf '%s\n' "$PACK_OUTPUT" | tail -n 1 | tr -d '\r')"
[ -f "$PACK_FILE" ] || PACK_FILE="$TMP_DIR/$(basename "$PACK_FILE")"
[ -f "$PACK_FILE" ] || {
  echo "expected packed tarball at $PACK_FILE" >&2
  exit 1
}

build_cmd=(docker build)
if [ -n "$BUILD_PLATFORM" ]; then
  build_cmd=(docker buildx build --platform "$BUILD_PLATFORM")
  if [ "$PUSH_IMAGE" = "1" ]; then
    build_cmd+=(--push)
  else
    build_cmd+=(--load)
  fi
elif [ "$PUSH_IMAGE" = "1" ]; then
  echo "warning: OPENCLAW_SRE_PUSH=1 requires OPENCLAW_SRE_BUILD_PLATFORM to be set; building locally without push" >&2
fi

"${build_cmd[@]}" \
  -f "${REPO_ROOT}/docker/sre-runtime.Dockerfile" \
  --build-arg "OPENCLAW_LOCAL_TARBALL=$(basename "$PACK_FILE")" \
  -t "$IMAGE_NAME" \
  "$TMP_DIR"
