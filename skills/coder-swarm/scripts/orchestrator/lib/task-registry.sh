#!/bin/bash
# Task registry management for agent orchestrator
# Stores state in ~/.openclaw/agent-tasks.json

REGISTRY_FILE="${HOME}/.openclaw/agent-tasks.json"

# Initialize registry if it doesn't exist
init_registry() {
    if [[ ! -f "$REGISTRY_FILE" ]]; then
        echo '{"tasks":[]}' > "$REGISTRY_FILE"
    fi
}

# Add a new task
# Usage: add_task <task_id> <agent> <repo> <branch> <worktree> <host> <tmux_session> <description>
add_task() {
    local task_id="$1"
    local agent="$2"
    local repo="$3"
    local branch="$4"
    local worktree="$5"
    local host="$6"
    local tmux_session="$7"
    local description="$8"
    local started_at=$(date +%s)000  # milliseconds

    init_registry

    local task=$(cat <<EOF
{
  "id": "$task_id",
  "agent": "$agent",
  "repo": "$repo",
  "branch": "$branch",
  "worktree": "$worktree",
  "host": "$host",
  "tmuxSession": "$tmux_session",
  "description": "$description",
  "startedAt": $started_at,
  "status": "running",
  "notifyOnComplete": true
}
EOF
)

    jq --argjson task "$task" '.tasks += [$task]' "$REGISTRY_FILE" > "$REGISTRY_FILE.tmp"
    mv "$REGISTRY_FILE.tmp" "$REGISTRY_FILE"
}

# Update task status
# Usage: update_task_status <task_id> <status> [pr_number] [note]
update_task_status() {
    local task_id="$1"
    local status="$2"
    local pr="${3:-}"
    local note="${4:-}"
    local completed_at=$(date +%s)000

    init_registry

    local updates=".tasks |= map(if .id == \"$task_id\" then .status = \"$status\""
    
    if [[ "$status" == "done" ]]; then
        updates="$updates | .completedAt = $completed_at"
    fi
    
    if [[ -n "$pr" ]]; then
        updates="$updates | .pr = $pr"
    fi
    
    if [[ -n "$note" ]]; then
        updates="$updates | .note = \"$note\""
    fi
    
    updates="$updates else . end)"

    jq "$updates" "$REGISTRY_FILE" > "$REGISTRY_FILE.tmp"
    mv "$REGISTRY_FILE.tmp" "$REGISTRY_FILE"
}

# Update task checks
# Usage: update_task_checks <task_id> <check_name> <value>
update_task_checks() {
    local task_id="$1"
    local check_name="$2"
    local value="$3"

    init_registry

    jq ".tasks |= map(if .id == \"$task_id\" then .checks.${check_name} = ${value} else . end)" \
        "$REGISTRY_FILE" > "$REGISTRY_FILE.tmp"
    mv "$REGISTRY_FILE.tmp" "$REGISTRY_FILE"
}

# Get all running tasks
get_running_tasks() {
    init_registry
    jq -r '.tasks[] | select(.status == "running") | .id' "$REGISTRY_FILE"
}

# Get task details
# Usage: get_task <task_id>
get_task() {
    local task_id="$1"
    init_registry
    jq -r ".tasks[] | select(.id == \"$task_id\")" "$REGISTRY_FILE"
}

# Remove completed tasks older than N days
# Usage: cleanup_old_tasks <days>
cleanup_old_tasks() {
    local days="${1:-7}"
    local cutoff=$(($(date +%s) - (days * 86400)))000

    init_registry

    jq ".tasks |= map(select(.status != \"done\" or .completedAt > $cutoff))" \
        "$REGISTRY_FILE" > "$REGISTRY_FILE.tmp"
    mv "$REGISTRY_FILE.tmp" "$REGISTRY_FILE"
}
