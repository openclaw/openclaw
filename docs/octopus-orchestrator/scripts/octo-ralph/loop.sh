#!/usr/bin/env bash
# Octopus Orchestrator — Ralph Loop
#
# Runs one task per iteration via an OpenClaw native subagent.
# Exits cleanly on milestone completion, cost breach, or graceful stop marker.
#
# Usage:
#   bash docs/octopus-orchestrator/scripts/octo-ralph/loop.sh
#
# Env vars:
#   OCTO_RALPH_MAX_ITERATIONS     default 9999
#   OCTO_RALPH_COST_BUDGET_USD    default 100.00
#   OCTO_RALPH_MAX_TASK_ATTEMPTS  default 3
#   OCTO_RALPH_AGENT_CMD          default "openclaw agent"
#   OCTO_RALPH_SLEEP_BETWEEN_S    default 2

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
cd "$REPO_ROOT"

OCTO_DIR="docs/octopus-orchestrator"
SCRIPTS="$OCTO_DIR/scripts/octo-ralph"
STOP_MARKER="$OCTO_DIR/.stop-after-current-task"

MAX_ITERATIONS="${OCTO_RALPH_MAX_ITERATIONS:-9999}"
COST_BUDGET="${OCTO_RALPH_COST_BUDGET_USD:-100.00}"
MAX_ATTEMPTS="${OCTO_RALPH_MAX_TASK_ATTEMPTS:-3}"
AGENT_CMD="${OCTO_RALPH_AGENT_CMD:-openclaw agent}"
SLEEP_S="${OCTO_RALPH_SLEEP_BETWEEN_S:-2}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ralph: $*"; }

iteration=0
while [[ $iteration -lt $MAX_ITERATIONS ]]; do
    iteration=$((iteration + 1))
    log "iteration $iteration / $MAX_ITERATIONS"

    # Graceful stop marker
    if [[ -f "$STOP_MARKER" ]]; then
        log "stop marker detected — finishing cleanly"
        rm -f "$STOP_MARKER"
        exit 0
    fi

    # Pre-task checks
    if ! bash "$SCRIPTS/pre-task.sh"; then
        log "pre-task check failed — exiting"
        exit 1
    fi

    # Check cost budget
    accumulated=$(grep -Eo 'COST_USD_ACCUMULATED: *[0-9.]+' "$OCTO_DIR/STATE.md" | grep -Eo '[0-9.]+')
    if awk "BEGIN {exit !($accumulated >= $COST_BUDGET)}"; then
        log "cost budget breached ($accumulated >= $COST_BUDGET) — exiting"
        printf "\n# Cost breach at iteration %d — accumulated %s vs budget %s\n" \
            "$iteration" "$accumulated" "$COST_BUDGET" >> "$OCTO_DIR/STATE.md"
        exit 0
    fi

    # Check for eligible task
    if ! bash "$SCRIPTS/has-eligible-task.sh" > /dev/null; then
        log "no eligible tasks — exiting"
        echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ) | none | no_eligible_tasks | — | 0.00 | loop exit" >> "$OCTO_DIR/STATE.md"
        exit 0
    fi

    # Dispatch the agent with PROMPT.md
    log "dispatching agent for next ready task"
    set +e
    $AGENT_CMD "$(cat <<EOF
You are starting a Ralph-loop iteration for the Octopus Orchestrator build.

Read and follow these files in order:
1. docs/octopus-orchestrator/PROMPT.md — your operating protocol
2. docs/octopus-orchestrator/STATE.md — current state
3. docs/octopus-orchestrator/TASKS.md — pick the next eligible task

Max retry attempts for this iteration: $MAX_ATTEMPTS

Execute one task and exit. Do not start a second task.
EOF
)"
    agent_exit=$?
    set -e

    if [[ $agent_exit -ne 0 ]]; then
        log "agent exited with code $agent_exit — stopping loop"
        exit $agent_exit
    fi

    # Post-task checks
    if ! bash "$SCRIPTS/post-task.sh"; then
        log "post-task check failed — exiting"
        exit 1
    fi

    sleep "$SLEEP_S"
done

log "max iterations reached — exiting"
exit 0
