#!/usr/bin/env bash
# Runs QA diagnostics smoke checks inside the shared package-installed Docker
# E2E image. The OpenClaw app under test comes from the prepared npm tarball;
# only QA harness files are mounted read-only.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-docker-observability-e2e:local" OPENCLAW_DOCKER_OBSERVABILITY_E2E_IMAGE OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE)"
SKIP_BUILD="${OPENCLAW_DOCKER_OBSERVABILITY_E2E_SKIP_BUILD:-0}"
LOOPS="${OPENCLAW_DOCKER_OBSERVABILITY_LOOPS:-1}"
OUTPUT_DIR="${OPENCLAW_DOCKER_OBSERVABILITY_OUTPUT_DIR:-$ROOT_DIR/.artifacts/docker-observability/$(date +%Y%m%d-%H%M%S)}"

if ! [[ "$LOOPS" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPENCLAW_DOCKER_OBSERVABILITY_LOOPS must be a positive integer, got: $LOOPS" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

docker_e2e_build_or_reuse "$IMAGE_NAME" docker-observability "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"
docker_e2e_harness_mount_args

echo "Running Docker observability smoke with $LOOPS loop(s)..."
run_logged docker-observability docker run --rm \
  -e "OPENCLAW_DOCKER_OBSERVABILITY_LOOPS=$LOOPS" \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  -v "$ROOT_DIR/scripts/qa-otel-smoke.ts:/app/scripts/qa-otel-smoke.ts:ro" \
  -v "$ROOT_DIR/qa:/app/qa:ro" \
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
  # The functional image has a global tsx runner for mounted harness files; the
  # published package intentionally does not ship tsx as an app dependency.
  tsx scripts/qa-otel-smoke.ts \
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
