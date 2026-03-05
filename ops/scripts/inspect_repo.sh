#!/usr/bin/env bash
set -euo pipefail

TASK_DIR="ops/tasks"

log() {
  echo "[inspect_repo] $*"
}

# Only run if no pending tasks exist
PENDING=$(jq -r '.status' $TASK_DIR/task-*.json 2>/dev/null | grep pending || true)

if [[ -n "$PENDING" ]]; then
  log "pending tasks exist — skipping inspection"
  exit 0
fi

log "scanning repository for improvement opportunities..."

# Detect TODO comments
TODO_COUNT=$(grep -R "TODO" . --exclude-dir=.git | wc -l || true)

if (( TODO_COUNT > 0 )); then
  log "found TODO comments — creating task"
  ops/scripts/create_task.sh \
    "Resolve TODO comments" \
    "Scan repository and resolve TODO comments found in the codebase."
fi

# Detect scripts missing strict bash mode
MISSING_STRICT=$(grep -L "set -euo pipefail" ops/scripts/*.sh || true)

if [[ -n "$MISSING_STRICT" ]]; then
  log "scripts missing strict mode — creating task"
  ops/scripts/create_task.sh \
    "Add strict bash mode" \
    "Ensure all scripts in ops/scripts use set -euo pipefail."
fi

log "inspection complete"
