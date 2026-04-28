#!/usr/bin/env bash
# Idempotently install the weekly RLS-scanner crontab entry.
# Runs every Monday at 8 AM ET (12:00 UTC).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
LOG_FILE="${LOG_FILE:-/tmp/rls-scanner.log}"

CRON_LINE="0 12 * * 1 cd ${REPO_DIR} && ${NODE_BIN} dist/index.js >> ${LOG_FILE} 2>&1"
TAG="# rls-scanner"

CURRENT="$(crontab -l 2>/dev/null || true)"
FILTERED="$(printf "%s\n" "$CURRENT" | grep -v "$TAG" || true)"

NEW="$(printf "%s\n%s %s\n" "$FILTERED" "$CRON_LINE" "$TAG")"
# Trim leading blank lines if the previous crontab was empty
NEW="$(printf "%s" "$NEW" | sed -e "/./,$ !d")"

printf "%s\n" "$NEW" | crontab -
echo "Installed cron entry:"
echo "  $CRON_LINE  $TAG"
