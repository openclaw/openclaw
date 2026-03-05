#!/usr/bin/env bash
set -euo pipefail

TITLE="$1"
GOAL="$2"

TASK_DIR="ops/tasks"

# find next task number
LAST_ID=$(ls $TASK_DIR/task-*.json 2>/dev/null | sed 's/.*task-\([0-9]*\).json/\1/' | sort -n | tail -1)

if [[ -z "$LAST_ID" ]]; then
  NEXT_ID=1
else
  NEXT_ID=$((LAST_ID + 1))
fi

TASK_FILE=$(printf "%s/task-%03d.json" "$TASK_DIR" "$NEXT_ID")

cat > "$TASK_FILE" <<EOF
{
  "task_id": "task-$(printf "%03d" $NEXT_ID)",
  "mission": "mission-auto",
  "title": "$TITLE",
  "owner": "strike-team-alpha",
  "goal": "$GOAL",
  "acceptance_criteria": [
    "task executed successfully",
    "gate_archive PASS"
  ],
  "status": "pending"
}
EOF

echo "[create_task] created $TASK_FILE"
