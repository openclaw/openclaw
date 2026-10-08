#!/usr/bin/env bash
set -euo pipefail
: "${CELL_DEADLINE_EPOCH_SECONDS:?repair-readiness requires its caller-owned absolute deadline}"
exec node /tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/published-driver.mjs \
  "$OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC" /tmp/openclaw-upgrade-survivor-artifacts \
  "${OPENCLAW_UPGRADE_SURVIVOR_BASELINE#openclaw@}" repair-readiness
