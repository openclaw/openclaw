#!/bin/sh
# OpenClaw Docker entrypoint with init script support.
#
# Runs any executable scripts found in /openclaw-init.d/ before starting
# the main process. This allows users to mount custom initialization
# scripts (e.g., install dependencies, apply patches, start services)
# without overriding the entire entrypoint.
#
# Usage in docker-compose.yml:
#   volumes:
#     - ./my-init-scripts:/openclaw-init.d:ro

INIT_DIR="/openclaw-init.d"

if [ -d "$INIT_DIR" ] && [ "$(ls -A "$INIT_DIR" 2>/dev/null)" ]; then
  echo "[openclaw-init] Running init scripts from $INIT_DIR..."
  for script in "$INIT_DIR"/*; do
    [ -f "$script" ] || continue
    if [ -x "$script" ]; then
      echo "[openclaw-init] Running $(basename "$script")..."
      output=$("$script" 2>&1)
      rc=$?
      if [ -n "$output" ]; then
        printf '%s\n' "$output" | sed 's/^/  /'
      fi
      if [ $rc -ne 0 ]; then
        echo "[openclaw-init] WARNING: $(basename "$script") exited with status $rc"
      fi
    else
      echo "[openclaw-init] SKIP: $(basename "$script") (not executable)"
    fi
  done
  echo "[openclaw-init] Init complete."
fi

exec "$@"
