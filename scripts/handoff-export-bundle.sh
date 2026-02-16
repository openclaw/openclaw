#!/usr/bin/env bash
set -euo pipefail

WORKSTREAM="${1:-E6-F1-S1}"
WHO="${2:-$(whoami)}"
STAMP="${3:-$(date +%F__%H%M)}"
SLUG="${4:-handoff}"
OUT_DIR="${5:-handoff/inbox}"

mkdir -p "$OUT_DIR"

ARTIFACT_NAME="${WORKSTREAM}__${WHO}__${STAMP}__${SLUG}.bundle"
ARTIFACT_PATH="${OUT_DIR}/${ARTIFACT_NAME}"

git bundle create "$ARTIFACT_PATH" --all
echo "Wrote: ${ARTIFACT_PATH}"
