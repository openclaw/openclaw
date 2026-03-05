#!/usr/bin/env bash
set -euo pipefail
TASK_ID="${1:?task-id required}"
ROOT="$(git rev-parse --show-toplevel)"
REG="$ROOT/.clawdbot/active-tasks.json"
TASK="$(jq -c --arg id "$TASK_ID" '.tasks[] | select(.id==$id)' "$REG")"
if [[ -z "$TASK" ]]; then
  echo "Task not found: $TASK_ID"
  exit 1
fi

ATTEMPT="$(echo "$TASK" | jq -r '.attempt')"
MAX="$(echo "$TASK" | jq -r '.max_retries')"
if (( ATTEMPT >= MAX )); then
  echo "Retry budget exhausted for $TASK_ID"
  exit 2
fi

BRANCH="$(echo "$TASK" | jq -r '.branch')"
WORKTREE="$(echo "$TASK" | jq -r '.worktree')"
SESSION="$(echo "$TASK" | jq -r '.session')"
AGENT="$(echo "$TASK" | jq -r '.agent')"
PROMPT_FILE="$(echo "$TASK" | jq -r '.prompt_file')"

cd "$ROOT"
if [[ ! -e "$WORKTREE/.git" ]]; then
  git worktree add "$WORKTREE" "$BRANCH"
fi

PIPELINE_SKILL="/home/ubuntu/.openclaw/workspace/skills/code-pipeline/scripts/pipeline-run.sh"

if [[ "$AGENT" == "claude" ]]; then
  CMD="claude --dangerously-skip-permissions \"\$(cat '$PROMPT_FILE')\""
elif [[ "$AGENT" == "pipeline" ]]; then
  CMD="bash '$PIPELINE_SKILL' --repo '$ROOT' --task \"\$(cat '$PROMPT_FILE')\" --task-id '$TASK_ID' --base main --max-rounds $MAX"
else
  CMD="codex --full-auto \"\$(cat '$PROMPT_FILE')\""
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
fi
tmux new-session -d -s "$SESSION" "cd '$WORKTREE' && $CMD"

NOW="$(date -Iseconds)"
TMP="$(mktemp)"
jq --arg id "$TASK_ID" --arg now "$NOW" '
  .tasks |= map(if .id==$id then .attempt += 1 | .status="in_progress" | .updated_at=$now | .last_error=null else . end)
' "$REG" > "$TMP" && mv "$TMP" "$REG"

echo "Retried $TASK_ID"
