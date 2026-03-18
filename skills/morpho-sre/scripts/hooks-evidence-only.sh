#!/usr/bin/env sh
# On-demand hook: /evidence-only
# Suppresses hypothesis generation and auto-PR. Bot only collects and presents facts.

set -eu

DATADIR="${CLAUDE_PLUGIN_DATA:-${XDG_RUNTIME_DIR:-/tmp}}"
mkdir -p "$DATADIR"
EVIDENCE_FILE="$DATADIR/.sre-evidence-only"

case "${1:-activate}" in
  activate)
    printf '%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$EVIDENCE_FILE"
    chmod 600 "$EVIDENCE_FILE"
    echo "EVIDENCE_ONLY=1"
    echo "Evidence-only mode active. No hypotheses, no auto-PR. Facts only."
    ;;
  deactivate)
    rm -f "$EVIDENCE_FILE"
    echo "EVIDENCE_ONLY=0"
    echo "Evidence-only mode deactivated. Full analysis resumed."
    ;;
  check)
    if [ -f "$EVIDENCE_FILE" ]; then
      echo "EVIDENCE_ONLY_ACTIVE since $(cat "$EVIDENCE_FILE")"
      exit 0
    else
      echo "EVIDENCE_ONLY_INACTIVE"
      exit 1
    fi
    ;;
esac
