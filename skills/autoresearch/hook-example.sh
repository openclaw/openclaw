#!/usr/bin/env bash
# autoresearch-morning.sh — fires on OnSessionStart, runs the loop in background
LOGFILE="$HOME/.autoresearch/hook.log"
mkdir -p "$HOME/.autoresearch"
{
  echo "=== $(date -Iseconds) hook fired ==="
  cd /c/AI/openclaw || exit 1
  node skills/autoresearch/loop.mjs 2>&1 || echo "exited with error"
  echo "=== done ==="
} >> "$LOGFILE" &
# Exit immediately so Claude Code session isn't blocked
exit 0
