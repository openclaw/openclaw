#!/usr/bin/env bash

set -euo pipefail

mkdir -p reports/openclaw-doctor ledgers
STAMP="$(date +%Y%m%d-%H%M%S)"
PRE="reports/openclaw-doctor/pre-repair-${STAMP}.json"
POST="reports/openclaw-doctor/post-repair-${STAMP}.json"

set +e
pnpm openclaw doctor --lint --json --severity-min warning > "$PRE"
PRE_STATUS=$?
set -e

if [[ "$PRE_STATUS" -eq 0 ]]; then
  node scripts/append_operational_ledger.cjs \
    --event openclaw_safe_repair \
    --status blocked \
    --reason pre_lint_passed_no_repair_required \
    --artifact "$PRE"
  echo "Wrote $PRE"
  exit 2
fi

set +e
pnpm openclaw doctor --repair --non-interactive --yes
REPAIR_STATUS=$?
pnpm openclaw doctor --lint --json --severity-min warning > "$POST"
POST_STATUS=$?
set -e

LEDGER_STATUS="pass"
if [[ "$REPAIR_STATUS" -ne 0 || "$POST_STATUS" -ne 0 ]]; then
  LEDGER_STATUS="fail"
fi

node scripts/append_operational_ledger.cjs \
  --event openclaw_safe_repair \
  --status "$LEDGER_STATUS" \
  --artifact "$PRE" \
  --artifact "$POST"

echo "Wrote $PRE"
echo "Wrote $POST"

if [[ "$REPAIR_STATUS" -ne 0 ]]; then
  exit "$REPAIR_STATUS"
fi
exit "$POST_STATUS"
