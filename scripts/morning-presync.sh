#!/usr/bin/env bash
# Pre-morning-report sync: forces a fresh pull from all data sources
# Runs at 7:50 AM MT weekdays, 10 minutes before JR's morning report
set -euo pipefail

cd /Users/vero/openclaw

echo "=== Morning pre-sync $(date) ==="

echo "  [1/3] Coperniq sync..."
/opt/homebrew/bin/pnpm exec tsx scripts/coperniq-sync.ts --quick

echo "  [2/3] Slack sync..."
/opt/homebrew/bin/pnpm exec tsx scripts/slack-sync.ts

echo "  [3/3] Email sync..."
/opt/homebrew/bin/pnpm exec tsx scripts/email-sync.ts

echo "  [4/4] Building morning report brief..."
/opt/homebrew/bin/pnpm exec tsx scripts/morning-report-data.ts

echo "=== Pre-sync complete ==="
