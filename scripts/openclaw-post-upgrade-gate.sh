#!/usr/bin/env bash

set -euo pipefail

mkdir -p reports/openclaw-doctor ledgers
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="reports/openclaw-doctor/post-upgrade-${STAMP}.json"

set +e
pnpm openclaw doctor --post-upgrade --json > "$OUT"
DOCTOR_STATUS=$?
set -e

LEDGER_STATUS="pass"
if [[ "$DOCTOR_STATUS" -ne 0 ]]; then
  LEDGER_STATUS="fail"
fi

node scripts/append_operational_ledger.cjs \
  --event openclaw_post_upgrade_gate \
  --status "$LEDGER_STATUS" \
  --artifact "$OUT"

echo "Wrote $OUT"
exit "$DOCTOR_STATUS"
