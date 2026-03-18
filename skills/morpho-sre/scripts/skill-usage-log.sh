#!/usr/bin/env sh
# Logs skill/script/reference usage for measurement and optimization.
# Usage: skill-usage-log.sh <script-or-reference-name> <context> [duration_sec]
#
# Examples:
#   skill-usage-log.sh sentinel-triage.sh heartbeat 45
#   skill-usage-log.sh db-first-incidents.md slack-thread
#   skill-usage-log.sh --report  (show usage summary)

set -eu

DATADIR="${CLAUDE_PLUGIN_DATA:-/tmp/openclaw-sre-data}"
LOGFILE="$DATADIR/skill-usage.jsonl"
mkdir -p "$DATADIR"

case "${1:---help}" in
  --report)
    if [ ! -f "$LOGFILE" ]; then
      echo "No usage data yet."
      exit 0
    fi
    echo "=== Script Usage (top 20) ==="
    jq -r '.script // .reference' "$LOGFILE" | sort | uniq -c | sort -rn | head -20
    echo ""
    echo "=== Context Distribution ==="
    jq -r '.context' "$LOGFILE" | sort | uniq -c | sort -rn
    echo ""
    echo "=== Total entries: $(wc -l < "$LOGFILE") ==="
    ;;
  --help)
    echo "Usage: skill-usage-log.sh <name> <context> [duration_sec]"
    echo "       skill-usage-log.sh --report"
    ;;
  *)
    NAME="$1"
    CONTEXT="${2:-unknown}"
    DURATION="${3:-}"

    # Determine if this is a script or reference
    if echo "$NAME" | grep -q '\.sh$'; then
      KEY="script"
    else
      KEY="reference"
    fi

    ENTRY="{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"${KEY}\":\"${NAME}\",\"context\":\"${CONTEXT}\""
    if [ -n "$DURATION" ]; then
      ENTRY="${ENTRY},\"duration_sec\":${DURATION}"
    fi
    ENTRY="${ENTRY}}"

    echo "$ENTRY" >> "$LOGFILE"
    ;;
esac
