#!/usr/bin/env sh
# On-demand hook: /evidence-only
# Suppresses hypothesis generation and auto-PR. Bot only collects and presents facts.

set -eu

EVIDENCE_FILE="${CLAUDE_PLUGIN_DATA:-/tmp}/.sre-evidence-only"

case "${1:-activate}" in
  activate)
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$EVIDENCE_FILE"
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
