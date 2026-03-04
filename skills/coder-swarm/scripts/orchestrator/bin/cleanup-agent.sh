#!/bin/bash
set -euo pipefail

# Agent orchestrator - cleanup completed tasks
# Usage: cleanup-agent.sh <task_id> [--force]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$ROOT_DIR/lib/task-registry.sh"

TASK_ID="${1:-}"
FORCE=false

if [[ -z "$TASK_ID" ]]; then
    echo "Usage: cleanup-agent.sh <task_id> [--force]"
    exit 1
fi

if [[ "${2:-}" == "--force" ]]; then
    FORCE=true
fi

# Get task details
task_json=$(get_task "$TASK_ID")

if [[ -z "$task_json" || "$task_json" == "null" ]]; then
    echo "Error: Task $TASK_ID not found"
    exit 1
fi

status=$(echo "$task_json" | jq -r '.status')
host=$(echo "$task_json" | jq -r '.host')
tmux_session=$(echo "$task_json" | jq -r '.tmuxSession')
worktree=$(echo "$task_json" | jq -r '.worktree')
branch=$(echo "$task_json" | jq -r '.branch')
repo=$(echo "$task_json" | jq -r '.repo')

echo "==> Cleaning up task: $TASK_ID"
echo "    Status: $status"
echo "    Worktree: $worktree"
echo "    Branch: $branch"

# Confirm if not forced and task isn't done
if [[ "$FORCE" != "true" && "$status" != "done" ]]; then
    read -p "Task is not marked done. Continue cleanup? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cleanup cancelled"
        exit 0
    fi
fi

# Function to execute cleanup on host
cleanup_on_host() {
    local cmd="$1"
    
    if [[ "$host" == "local" ]]; then
        bash -c "$cmd"
    else
        ssh "$host" "bash -c '$cmd'"
    fi
}

CLEANUP_SCRIPT=$(cat <<'EOFSCRIPT'
set -euo pipefail

TMUX_SESSION="__TMUX_SESSION__"
WORKTREE="__WORKTREE__"
REPO="__REPO__"
BRANCH="__BRANCH__"

# Kill tmux session if it exists
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "Killing tmux session: $TMUX_SESSION"
    tmux kill-session -t "$TMUX_SESSION"
fi

# Remove worktree
if [[ -d "$WORKTREE" ]]; then
    echo "Removing worktree: $WORKTREE"
    cd "$REPO"
    git worktree remove "$WORKTREE" --force || true
    rm -rf "$WORKTREE" 2>/dev/null || true
fi

# Delete remote branch if it was pushed
cd "$REPO"
if git show-ref --verify --quiet refs/remotes/origin/"$BRANCH"; then
    echo "Deleting remote branch: $BRANCH"
    git push origin --delete "$BRANCH" 2>/dev/null || true
fi

# Delete local branch
if git show-ref --verify --quiet refs/heads/"$BRANCH"; then
    echo "Deleting local branch: $BRANCH"
    git branch -D "$BRANCH" 2>/dev/null || true
fi

echo "Cleanup complete"
EOFSCRIPT
)

# Replace placeholders (properly escaped for shell injection protection)
tmux_session_escaped=$(printf %q "$tmux_session")
worktree_escaped=$(printf %q "$worktree")
repo_escaped=$(printf %q "$repo")
branch_escaped=$(printf %q "$branch")

CLEANUP_SCRIPT="${CLEANUP_SCRIPT//__TMUX_SESSION__/$tmux_session_escaped}"
CLEANUP_SCRIPT="${CLEANUP_SCRIPT//__WORKTREE__/$worktree_escaped}"
CLEANUP_SCRIPT="${CLEANUP_SCRIPT//__REPO__/$repo_escaped}"
CLEANUP_SCRIPT="${CLEANUP_SCRIPT//__BRANCH__/$branch_escaped}"

# Execute cleanup
cleanup_on_host "$CLEANUP_SCRIPT"

# Update registry
update_task_status "$TASK_ID" "cleaned" "" "Worktree and branches removed"

echo "==> Task cleaned: $TASK_ID"
