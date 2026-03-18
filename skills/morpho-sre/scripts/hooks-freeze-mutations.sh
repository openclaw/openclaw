#!/usr/bin/env sh
# On-demand hook: /freeze-mutations
# When active, prevents auto-PR creation and Linear ticket mutations.
# Run with activate/deactivate/check subcommands.
#
# Activated by: /freeze-mutations slash command
# Deactivated by: /unfreeze-mutations or new session
# Exit code contract: check returns 0=active, 1=inactive (same as sibling hooks)

set -eu

DATADIR="${CLAUDE_PLUGIN_DATA:-${XDG_RUNTIME_DIR:-/tmp}}"
mkdir -p "$DATADIR"
FREEZE_FILE="$DATADIR/.sre-freeze-mutations"

case "${1:-activate}" in
  activate)
    printf '%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$FREEZE_FILE"
    chmod 600 "$FREEZE_FILE"
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
      exit 0
    else
      echo "NOT_FROZEN"
      exit 1
    fi
    ;;
esac
