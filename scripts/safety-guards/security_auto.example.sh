#!/usr/bin/env bash
set -euo pipefail
# Security orchestrator (template): picks guard by mode.

USAGE='Usage: security_auto.example.sh [exec|web|publish] ...'
[ "$#" -ge 1 ] || { echo "$USAGE" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="$1"; shift

case "$MODE" in
  exec)
    "$SCRIPT_DIR/safe_exec.example.sh" "$@"
    ;;
  web)
    "$SCRIPT_DIR/web_input_guard.example.sh" "$@"
    ;;
  publish)
    "$SCRIPT_DIR/public_publish_guard.example.sh" "$@"
    ;;
  *)
    echo "$USAGE" >&2
    exit 2
    ;;
esac
