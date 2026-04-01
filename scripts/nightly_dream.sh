#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${1:-/root/.openclaw/workspace}"
shift || true

python3 "${WORKSPACE}/scripts/openclaw_harness.py" nightly-dream-cycle \
  --workspace "${WORKSPACE}" \
  --days 7 \
  --focus-current-task \
  --min-hours 24 \
  --min-sources 2 \
  --max-items 3 \
  --apply \
  "$@"
