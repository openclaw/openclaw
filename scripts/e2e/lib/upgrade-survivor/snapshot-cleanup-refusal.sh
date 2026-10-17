#!/usr/bin/env bash
set -euo pipefail
export CELL_DEADLINE_EPOCH_SECONDS="${CELL_DEADLINE_EPOCH_SECONDS:-$(( $(date +%s) + 1125 ))}"
exec node /tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/published-driver.mjs \
  "$OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC" /tmp/openclaw-upgrade-survivor-artifacts \
  "${OPENCLAW_UPGRADE_SURVIVOR_BASELINE#openclaw@}" snapshot-cleanup-refusal
