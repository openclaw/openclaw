#!/usr/bin/env bash
# End-to-end proof for PR #97845: builds the Docker image, runs the harness inside
# the container against the bind-mounted repository, and prints + saves the captured
# BEFORE/AFTER normalized event streams.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="pr-97845-stream-proof"

echo "[run-proof] building image: $IMAGE"
docker build -t "$IMAGE" "$SCRIPT_DIR"

echo "[run-proof] running container (repo mounted read-write at /work)"
# The container writes captured output to proof/pr-97845/output on the host via the
# bind mount. Nothing else in the repo is modified (the BEFORE scratch copy lives in
# the container's temp dir).
docker run --rm -v "$REPO_ROOT":/work -w /work "$IMAGE"

echo
echo "================ BEFORE (fix reverted) ================"
cat "$SCRIPT_DIR/output/before.txt"
echo
echo "================ AFTER (fix in place) ================="
cat "$SCRIPT_DIR/output/after.txt"
echo
echo "==================== SUMMARY =========================="
cat "$SCRIPT_DIR/output/summary.txt"
