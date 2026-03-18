#!/usr/bin/env sh
# On-demand hook: /freeze-mutations
# When active, prevents auto-PR creation and Linear ticket mutations.
# Usage: source this script or set FREEZE_MUTATIONS=1 in environment.
#
# Activated by: /freeze-mutations slash command
# Deactivated by: /unfreeze-mutations or new session

set -eu

FREEZE_FILE="${CLAUDE_PLUGIN_DATA:-/tmp}/.sre-freeze-mutations"

case "${1:-activate}" in
  activate)
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$FREEZE_FILE"
    echo "FREEZE_MUTATIONS=1"
    echo "Mutations frozen. Auto-PR and Linear writes disabled until /unfreeze-mutations."
    ;;
  deactivate)
    rm -f "$FREEZE_FILE"
    echo "FREEZE_MUTATIONS=0"
    echo "Mutations unfrozen. Auto-PR and Linear writes re-enabled."
    ;;
  check)
    if [ -f "$FREEZE_FILE" ]; then
      echo "FROZEN since $(cat "$FREEZE_FILE")"
      exit 1
    else
      echo "NOT_FROZEN"
      exit 0
    fi
    ;;
esac
