#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-docker-observability-e2e:local" OPENCLAW_DOCKER_OBSERVABILITY_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_DOCKER_OBSERVABILITY_E2E_SKIP_BUILD:-0}"
LOOPS="${OPENCLAW_DOCKER_OBSERVABILITY_LOOPS:-1}"
OUTPUT_DIR="${OPENCLAW_DOCKER_OBSERVABILITY_OUTPUT_DIR:-$ROOT_DIR/.artifacts/docker-observability/$(date +%Y%m%d-%H%M%S)}"

if ! [[ "$LOOPS" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPENCLAW_DOCKER_OBSERVABILITY_LOOPS must be a positive integer, got: $LOOPS" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

docker_e2e_build_or_reuse "$IMAGE_NAME" docker-observability "$ROOT_DIR/scripts/e2e/Dockerfile.observability" "$ROOT_DIR" "" "$SKIP_BUILD"

echo "Running Docker observability smoke with $LOOPS loop(s)..."
run_logged docker-observability docker run --rm \
  -e "OPENCLAW_DOCKER_OBSERVABILITY_LOOPS=$LOOPS" \
  -v "$OUTPUT_DIR:/app/.artifacts/docker-observability-current" \
  "$IMAGE_NAME" \
  bash -lc '
set -euo pipefail

loops="${OPENCLAW_DOCKER_OBSERVABILITY_LOOPS:-1}"
artifact_root=".artifacts/docker-observability-current"
mkdir -p "$artifact_root"

for i in $(seq 1 "$loops"); do
  iteration_dir="$artifact_root/loop-$i"
  mkdir -p "$iteration_dir"

  echo "== docker observability loop $i/$loops: otel =="
  pnpm qa:otel:smoke \
    --provider-mode mock-openai \
    --output-dir "$iteration_dir/otel"

  echo "== docker observability loop $i/$loops: prometheus =="
  pnpm openclaw qa suite \
    --provider-mode mock-openai \
    --scenario docker-prometheus-smoke \
    --concurrency 1 \
    --fast \
    --output-dir "$iteration_dir/prometheus"
done
'

echo "Docker observability smoke passed. Artifacts: $OUTPUT_DIR"
