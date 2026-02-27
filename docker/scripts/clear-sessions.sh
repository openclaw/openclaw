#!/usr/bin/env bash
# clear-sessions.sh — Back up and clear LINE channel session history
#
# Purpose: Prevents "learned helplessness" where the LLM repeats past errors
# from stale conversation history instead of re-trying tools that now work.
#
# Usage:
#   Manual:     docker exec openclaw-sgnl-openclaw-1 bash /app/docker/scripts/clear-sessions.sh
#   Pre-deploy: docker compose run --rm clear-sessions
#
# Safe: creates timestamped backups before clearing.

set -euo pipefail

SESSIONS_DIR="/data/.openclaw/agents/main/sessions"
BACKUP_SUFFIX="bak.$(date -u +%Y%m%dT%H%M%SZ)"

if [ ! -d "$SESSIONS_DIR" ]; then
  echo "[clear-sessions] No sessions directory found at $SESSIONS_DIR — skipping."
  exit 0
fi

cleared=0
for f in "$SESSIONS_DIR"/line-*.jsonl; do
  [ -f "$f" ] || continue

  size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0)

  # Skip files smaller than 50KB — not worth clearing
  if [ "$size" -lt 51200 ]; then
    echo "[clear-sessions] Skip $(basename "$f") (${size}B < 50KB)"
    continue
  fi

  cp "$f" "${f}.${BACKUP_SUFFIX}"
  : > "$f"
  cleared=$((cleared + 1))
  echo "[clear-sessions] Cleared $(basename "$f") (was ${size}B, backup: $(basename "${f}.${BACKUP_SUFFIX}"))"
done

if [ "$cleared" -eq 0 ]; then
  echo "[clear-sessions] No large LINE sessions to clear."
else
  echo "[clear-sessions] Done. Cleared $cleared session(s). Backups saved with suffix .$BACKUP_SUFFIX"
fi
