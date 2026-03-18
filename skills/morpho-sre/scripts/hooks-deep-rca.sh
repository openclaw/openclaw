#!/usr/bin/env sh
# On-demand hook: /deep-rca
# Overrides the default "light triage" mode and forces full evidence collection.
# Sets DEEP_RCA=1 for the current investigation.

set -eu

DATADIR="${CLAUDE_PLUGIN_DATA:-${XDG_RUNTIME_DIR:-/tmp}}"
mkdir -p "$DATADIR"
DEEP_FILE="$DATADIR/.sre-deep-rca"

case "${1:-activate}" in
  activate)
    printf '%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEEP_FILE"
    chmod 600 "$DEEP_FILE"
    echo "DEEP_RCA=1"
    echo "Deep RCA mode active. Full evidence collection enabled for all incident types."
    ;;
  deactivate)
    rm -f "$DEEP_FILE"
    echo "DEEP_RCA=0"
    echo "Deep RCA mode deactivated. Returning to light triage default."
    ;;
  check)
    if [ -f "$DEEP_FILE" ]; then
      echo "DEEP_RCA_ACTIVE since $(cat "$DEEP_FILE")"
      exit 0
    else
      echo "DEEP_RCA_INACTIVE"
      exit 1
    fi
    ;;
esac
