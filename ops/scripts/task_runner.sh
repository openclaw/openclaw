#!/usr/bin/env bash
set -euo pipefail

TASK_DIR="ops/tasks"

TEAM_FILE="ops/strike_teams/alpha.json"

IMPLEMENTER_MODEL=$(jq -r '.roles[] | select(.id=="implementer") | .model' $TEAM_FILE)
REVIEWER_MODEL=$(jq -r '.roles[] | select(.id=="reviewer") | .model' $TEAM_FILE)

echo "[task_runner] implementer model: $IMPLEMENTER_MODEL"
echo "[task_runner] reviewer model: $REVIEWER_MODEL"
echo "[task_runner] scanning for tasks..."

for task in ${TASK_DIR}/task-*.json; do
  [ -e "$task" ] || continue

  status=$(jq -r '.status' "$task")

  if [[ "$status" == "pending" ]]; then
    echo "[task_runner] executing $task"

    # mark task running
    tmp=$(mktemp)
    jq '.status="running"' "$task" > "$tmp" && mv "$tmp" "$task"

    echo "[task_runner] running gate pipeline..."
    KEEP_TMP=1 bash ops/scripts/gate_archive.sh

    # mark task complete
    tmp=$(mktemp)
    jq '.status="complete"' "$task" > "$tmp" && mv "$tmp" "$task"

    echo "[task_runner] task complete"
  fi
done
