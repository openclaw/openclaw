#!/usr/bin/env bash
# Idempotent crontab installer for the RunPR weekly outreach pipeline.
#
# Schedule: every Monday at 13:00 UTC. That's 9 AM EDT (summer) / 8 AM EST (winter). Acceptable
# per the project README. If you want strict 9 AM ET year-round, use a wrapper that exits early
# on the off-week or run via Apple's launchd with calendar matching instead.

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$HOME/code/openclaw/agents/runpr-outreach}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
LOG_FILE="${LOG_FILE:-/tmp/runpr-outreach.log}"

CRON_LINE="0 13 * * 1 cd ${PROJECT_DIR} && ${NODE_BIN} dist/index.js weekly >> ${LOG_FILE} 2>&1"
MARKER="# runpr-outreach weekly cron"

current="$(crontab -l 2>/dev/null || true)"

if echo "${current}" | grep -F -q "${MARKER}"; then
  echo "[install.sh] cron entry already present. Updating it in place."
  filtered="$(echo "${current}" | awk -v marker="${MARKER}" '
    BEGIN { skip = 0 }
    {
      if ($0 == marker) { skip = 2; next }
      if (skip > 0) { skip--; next }
      print
    }
  ')"
else
  filtered="${current}"
fi

# Append the marker + line. Trailing newline matters for crontab.
{
  if [ -n "${filtered}" ]; then
    printf "%s\n" "${filtered}"
  fi
  printf "%s\n" "${MARKER}"
  printf "%s\n" "${CRON_LINE}"
} | crontab -

echo "[install.sh] crontab updated. Active entry:"
crontab -l | grep -A 1 "${MARKER}" || true
