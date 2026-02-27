#!/usr/bin/env bash
set -euo pipefail
TASK_ID="${1:?task-id required}"
PROMPT_FILE="${2:?prompt-file required}"
MODE="${3:-pipeline}"        # "pipeline" (默认，三阶段) | "codex" | "claude" (单 agent)
MAX_RETRIES="${4:-3}"
TITLE="${5:-$TASK_ID}"

ROOT="$(git rev-parse --show-toplevel)"
REG="$ROOT/.clawdbot/active-tasks.json"
PROMPT_ABS="$(cd "$(dirname "$PROMPT_FILE")" && pwd)/$(basename "$PROMPT_FILE")"
TASK_CONTENT="$(cat "$PROMPT_ABS")"
BRANCH="swarm/${TASK_ID}"
WORKTREE="/tmp/swarm-${TASK_ID}"
SESSION="swarm-${TASK_ID}"
PIPELINE_SKILL="/home/ubuntu/.openclaw/workspace/skills/code-pipeline/scripts/pipeline-run.sh"

cd "$ROOT"
git fetch origin 2>/dev/null || true

# ─── Pipeline 模式（默认）：三阶段 Codex→Claude→Codex ───
if [[ "$MODE" == "pipeline" ]]; then
  # pipeline-run.sh 自己管 worktree/tmux/PR
  # 用 tmux 包一层让它后台跑，session 名以 pipeline- 开头便于 monitor 识别
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
  fi
  tmux new-session -d -s "$SESSION" \
    "bash '$PIPELINE_SKILL' --repo '$ROOT' --task '$TASK_CONTENT' --task-id '$TASK_ID' --base main --max-rounds $MAX_RETRIES"

  # 注册到 task registry
  NOW="$(date -Iseconds)"
  TMP="$(mktemp)"
  jq --arg id "$TASK_ID" \
     --arg title "$TITLE" \
     --arg branch "pipeline/${TASK_ID}" \
     --arg session "$SESSION" \
     --arg prompt "$PROMPT_ABS" \
     --arg now "$NOW" \
     --argjson max "$MAX_RETRIES" '
    .tasks |= (
      map(select(.id != $id)) + [{
        id:$id,title:$title,agent:"pipeline",status:"in_progress",
        branch:("pipeline/"+$id),worktree:("/tmp/pipeline-"+$id),session:$session,prompt_file:$prompt,
        attempt:1,max_retries:$max,pr_number:null,pr_url:null,
        notified_ready:false,last_error:null,
        created_at:$now,updated_at:$now
      }]
    )
  ' "$REG" > "$TMP" && mv "$TMP" "$REG"

  echo "Spawned $TASK_ID (mode=pipeline, session=$SESSION)"
  exit 0
fi

# ─── 单 Agent 模式（兼容旧逻辑）───

if ! git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  git branch "$BRANCH" origin/main
fi

if [[ ! -d "$WORKTREE/.git" ]]; then
  git worktree add "$WORKTREE" "$BRANCH"
fi

if [[ "$MODE" == "claude" ]]; then
  CMD="claude --dangerously-skip-permissions \"$TASK_CONTENT\""
else
  CMD="codex --full-auto \"$TASK_CONTENT\""
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
fi
tmux new-session -d -s "$SESSION" "cd '$WORKTREE' && $CMD"

NOW="$(date -Iseconds)"
TMP="$(mktemp)"

jq --arg id "$TASK_ID" \
   --arg title "$TITLE" \
   --arg agent "$MODE" \
   --arg branch "$BRANCH" \
   --arg worktree "$WORKTREE" \
   --arg session "$SESSION" \
   --arg prompt "$PROMPT_ABS" \
   --arg now "$NOW" \
   --argjson max "$MAX_RETRIES" '
  .tasks |= (
    map(select(.id != $id)) + [{
      id:$id,title:$title,agent:$agent,status:"in_progress",
      branch:$branch,worktree:$worktree,session:$session,prompt_file:$prompt,
      attempt:1,max_retries:$max,pr_number:null,pr_url:null,
      notified_ready:false,last_error:null,
      created_at:$now,updated_at:$now
    }]
  )
' "$REG" > "$TMP" && mv "$TMP" "$REG"

echo "Spawned $TASK_ID (mode=$MODE, session=$SESSION)"
