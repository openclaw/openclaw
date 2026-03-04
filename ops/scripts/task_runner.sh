#!/usr/bin/env bash
set -euo pipefail

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  printf '%s [task_runner] %s\n' "$(timestamp)" "$*"
}

CURRENT_STEP=""
trap 'log "ERROR exit=$? step=${CURRENT_STEP:-unknown}"' ERR

TASK_DIR="ops/tasks"

TEAM_FILE="ops/strike_teams/alpha.json"

IMPLEMENTER_MODEL=$(jq -r '.roles[] | select(.id=="implementer") | .model' $TEAM_FILE)
REVIEWER_MODEL=$(jq -r '.roles[] | select(.id=="reviewer") | .model' $TEAM_FILE)

log "implementer model: $IMPLEMENTER_MODEL"
log "reviewer model: $REVIEWER_MODEL"
log "scanning for tasks..."

for task in ${TASK_DIR}/task-*.json; do
  [ -e "$task" ] || continue

  status=$(jq -r '.status' "$task")

  if [[ "$status" == "pending" ]]; then
    log "executing $task"

    # mark task running
    CURRENT_STEP="mark_running"
    tmp=$(mktemp)
    jq '.status="running"' "$task" > "$tmp" && mv "$tmp" "$task"
    CURRENT_STEP=""

    MAX_ATTEMPTS=3
attempt=1

while (( attempt <= MAX_ATTEMPTS )); do
  log "patch attempt $attempt..."

  CURRENT_STEP="generate_patch"
  bash ops/scripts/generate_patch.sh "$task"
  CURRENT_STEP=""

if [[ ! -f patch.diff ]]; then
  log "patch generation failed"
  ((attempt++))
  continue
fi

  log "reviewing patch..."

  CURRENT_STEP="review_patch"
  if bash ops/scripts/review_patch.sh patch.diff; then
    log "patch approved"
    CURRENT_STEP=""
    break
  fi
  CURRENT_STEP=""

  log "patch rejected (attempt $attempt)"
  rm -f patch.diff

  ((attempt++))
done

if (( attempt > MAX_ATTEMPTS )); then
  log "patch failed after $MAX_ATTEMPTS attempts"

  CURRENT_STEP="mark_failed"
  tmp=$(mktemp)
  jq '.status="failed"' "$task" > "$tmp" && mv "$tmp" "$task"
  CURRENT_STEP=""

  continue
fi
    log "applying patch..."
    CURRENT_STEP="apply_patch"
    bash ops/scripts/apply_patch_commit.sh patch.diff
    CURRENT_STEP=""

    rm -f patch.diff

    log "running gate pipeline..."
    CURRENT_STEP="run_gates"
    KEEP_TMP=1 bash ops/scripts/gate_archive.sh
    CURRENT_STEP=""

    # mark task complete
    CURRENT_STEP="mark_complete"
    tmp=$(mktemp)
    jq '.status="complete"' "$task" > "$tmp" && mv "$tmp" "$task"
    CURRENT_STEP=""

    log "task complete"
  fi
done
