#!/bin/bash
set -euo pipefail

# Agent orchestrator - monitor running agents
# Usage: check-agents.sh [--notify] [--verbose]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$ROOT_DIR/lib/task-registry.sh"

NOTIFY=false
VERBOSE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --notify)
            NOTIFY=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

log() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo "$@"
    fi
}

resolve_host_target() {
    local host="$1"
    case "$host" in
        local) echo "local" ;;
        mac-mini) echo "adam@mac-mini.tailcd0984.ts.net" ;;
        *) echo "$host" ;;
    esac
}

run_on_host() {
    local host="$1"
    local cmd="$2"
    local target
    target=$(resolve_host_target "$host")

    if [[ "$target" == "local" ]]; then
        bash -lc "$cmd"
    else
        ssh "$target" "bash -lc '$cmd'"
    fi
}

# Check if tmux session is alive on host
check_session() {
    local host="$1"
    local session="$2"
    run_on_host "$host" "tmux has-session -t '$session' 2>/dev/null"
}

get_pane_tail() {
    local host="$1"
    local session="$2"
    run_on_host "$host" "tmux capture-pane -pt '$session' | tail -60" 2>/dev/null || true
}

worktree_has_changes() {
    local host="$1"
    local worktree="$2"
    local out
    out=$(run_on_host "$host" "cd '$worktree' 2>/dev/null && git status --porcelain" 2>/dev/null || true)
    [[ -n "$out" ]]
}

agent_finished_but_session_open() {
    local host="$1"
    local session="$2"
    local worktree="$3"

    local pane last_line
    pane=$(get_pane_tail "$host" "$session")
    [[ -z "$pane" ]] && return 1

    last_line=$(echo "$pane" | awk 'NF{line=$0} END{print line}')

    # Prompt detected (shell is idle)
    local at_prompt=false
    if echo "$last_line" | grep -Eq '[@].*[#$] ?$|[#$] ?$'; then
        at_prompt=true
    fi

    # Common completion markers from coding CLIs
    local has_completion_marker=false
    if echo "$pane" | grep -Eiq 'tokens used|Created \[|Task completed|Done\.|All done|finished'; then
        has_completion_marker=true
    fi

    if [[ "$at_prompt" == "true" && "$has_completion_marker" == "true" ]]; then
        return 0
    fi

    # Fallback: prompt + dirty worktree likely means agent completed edits and returned
    if [[ "$at_prompt" == "true" ]] && worktree_has_changes "$host" "$worktree"; then
        return 0
    fi

    return 1
}

# Check if PR exists for branch
check_pr() {
    local repo="$1"
    local branch="$2"

    command -v gh >/dev/null 2>&1 || { echo ""; return 0; }
    cd "$repo" 2>/dev/null || { echo ""; return 0; }
    gh pr list --head "$branch" --json number --jq '.[0].number' 2>/dev/null || echo ""
}

# Check CI status for PR
check_ci() {
    local repo="$1"
    local pr="$2"

    command -v gh >/dev/null 2>&1 || { echo ""; return 0; }
    cd "$repo" 2>/dev/null || { echo ""; return 0; }
    gh pr view "$pr" --json statusCheckRollup --jq '.statusCheckRollup[0].conclusion' 2>/dev/null || echo ""
}

HOOK_BASE_URL="${HOOK_BASE_URL:-https://beelink2.tailcd0984.ts.net/hooks}"

resolve_hook_token() {
    if [[ -n "${CLAWD_TOKEN:-}" ]]; then
        echo "$CLAWD_TOKEN"
        return 0
    fi

    local cfg="$HOME/.openclaw/openclaw.json"
    if [[ -f "$cfg" ]] && command -v jq >/dev/null 2>&1; then
        jq -r '.hooks.token // empty' "$cfg" 2>/dev/null
        return 0
    fi

    echo ""
}

# Send human notification via MCP hook + machine event via swarm-events hook
notify() {
    local message="$1"
    local priority="${2:-normal}"
    local task_id="${3:-}"
    local agent="${4:-}"

    local token
    token="$(resolve_hook_token)"
    if [[ -z "$token" ]]; then
        log "  Warning: no hook token available; skipping notifications"
        return 0
    fi

    # Human route
    curl -s -X POST "$HOOK_BASE_URL/mcp" \
        -H "Authorization: Bearer ${token}" \
        -H "Content-Type: application/json" \
        -d "{\"message\":\"$message\",\"priority\":\"$priority\"}" >/dev/null 2>&1 || true

    # Agent/event route
    curl -s -X POST "$HOOK_BASE_URL/swarm-events" \
        -H "Authorization: Bearer ${token}" \
        -H "Content-Type: application/json" \
        -d "{\"taskId\":\"$task_id\",\"agent\":\"$agent\",\"message\":\"$message\",\"priority\":\"$priority\"}" >/dev/null 2>&1 || true
}

# Main monitoring loop
TASKS=$(get_running_tasks)

if [[ -z "$TASKS" ]]; then
    log "No running tasks"
    exit 0
fi

log "Checking $(echo "$TASKS" | wc -l) running task(s)..."

for task_id in $TASKS; do
    task_json=$(get_task "$task_id")
    
    agent=$(echo "$task_json" | jq -r '.agent')
    host=$(echo "$task_json" | jq -r '.host')
    tmux_session=$(echo "$task_json" | jq -r '.tmuxSession')
    repo=$(echo "$task_json" | jq -r '.repo')
    branch=$(echo "$task_json" | jq -r '.branch')
    worktree=$(echo "$task_json" | jq -r '.worktree')
    description=$(echo "$task_json" | jq -r '.description')
    
    log "Checking task: $task_id ($agent)"
    
    # Check if tmux session is still alive
    if ! check_session "$host" "$tmux_session"; then
        log "  Session died - checking if work was completed..."
        
        # Check if PR was created
        pr_number=$(check_pr "$repo" "$branch")
        
        if [[ -n "$pr_number" && "$pr_number" != "null" ]]; then
            log "  Found PR #$pr_number"
            update_task_status "$task_id" "done" "$pr_number" "Session completed, PR created"
            
            if [[ "$NOTIFY" == "true" ]]; then
                notify "✅ Agent task completed: $description\nPR #$pr_number ready for review" "normal" "$task_id" "$agent"
            fi
        else
            log "  No PR found - marking as failed"
            update_task_status "$task_id" "failed" "" "Session died without creating PR"
            
            if [[ "$NOTIFY" == "true" ]]; then
                notify "⚠️ Agent task failed: $description\nSession died without creating PR" "high" "$task_id" "$agent"
            fi
        fi
        continue
    fi
    
    # Session still alive - check if PR exists
    pr_number=$(check_pr "$repo" "$branch")
    
    if [[ -n "$pr_number" && "$pr_number" != "null" ]]; then
        log "  PR #$pr_number exists, checking CI..."
        
        # Update task with PR number if not already set
        current_pr=$(echo "$task_json" | jq -r '.pr // empty')
        if [[ -z "$current_pr" ]]; then
            update_task_status "$task_id" "running" "$pr_number"
        fi
        
        # Check CI status
        ci_status=$(check_ci "$repo" "$pr_number")
        
        case "$ci_status" in
            "SUCCESS")
                log "  CI passed!"
                update_task_checks "$task_id" "ciPassed" "true"
                update_task_status "$task_id" "done" "$pr_number" "CI passed, ready for review"
                
                if [[ "$NOTIFY" == "true" ]]; then
                    notify "✅ Agent task ready: $description\nPR #$pr_number - CI passed" "normal" "$task_id" "$agent"
                fi
                ;;
            "FAILURE")
                log "  CI failed"
                update_task_checks "$task_id" "ciPassed" "false"
                # Don't change status - let agent retry or human intervene
                ;;
            *)
                log "  CI pending or in progress"
                ;;
        esac
    else
        if agent_finished_but_session_open "$host" "$tmux_session" "$worktree"; then
            log "  Agent appears finished (shell prompt + completion markers)"
            update_task_status "$task_id" "done" "" "Agent finished in tmux; no PR detected yet"

            if [[ "$NOTIFY" == "true" ]]; then
                notify "✅ Agent task finished: $description\nNo PR detected yet. Review worktree: $worktree" "normal" "$task_id" "$agent"
            fi
        else
            log "  No PR yet, agent still working..."
        fi
    fi
done

log "Check complete"
