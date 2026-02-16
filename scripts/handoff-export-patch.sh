#!/usr/bin/env bash
set -euo pipefail

WORKSTREAM="${1:-E6-F1-S1}"
WHO="${2:-$(whoami)}"
STAMP="${3:-$(date +%F__%H%M)}"
SLUG="${4:-handoff}"
OUT_DIR="${5:-handoff/inbox}"
BASE="${6:-HEAD~1}"

mkdir -p "$OUT_DIR"

ARTIFACT_NAME="${WORKSTREAM}__${WHO}__${STAMP}__${SLUG}.patches"
ARTIFACT_PATH="${OUT_DIR}/${ARTIFACT_NAME}"
mkdir -p "$ARTIFACT_PATH"

git format-patch -o "$ARTIFACT_PATH" "${BASE}..HEAD"
echo "Wrote: ${ARTIFACT_PATH}"
