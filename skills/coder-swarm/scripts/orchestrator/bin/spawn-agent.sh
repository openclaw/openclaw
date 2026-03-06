#!/bin/bash
set -euo pipefail

# Agent orchestrator - spawn coding agent in isolated worktree
# Usage: spawn-agent.sh --task "description" --agent codex|claude|gemini [--repo path] [--host beelink2|mac-mini]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$ROOT_DIR/lib/task-registry.sh"

# Defaults
AGENT="codex"
REPO_PATH=""
HOST="auto"
TASK_DESC=""
TASK_FILE=""
TASK_B64=""
BRANCH_PREFIX="agent-task"
WATCHERS="[]"

# PR target: "origin" (default, fork-safe) or "upstream" (explicit opt-in)
SWARM_PR_TARGET="${SWARM_PR_TARGET:-origin}"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --task)
            TASK_DESC="$2"
            shift 2
            ;;
        --agent)
            AGENT="$2"
            shift 2
            ;;
        --repo)
            REPO_PATH="$2"
            shift 2
            ;;
        --task-file)
            TASK_FILE="$2"
            shift 2
            ;;
        --host)
            HOST="$2"
            shift 2
            ;;
        --watchers)
            WATCHERS="$2"
            shift 2
            ;;
        --target-upstream)
            # Explicit opt-in to target upstream remote for PR creation
            SWARM_PR_TARGET="upstream"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

if [[ -n "$TASK_FILE" ]]; then
    if [[ ! -f "$TASK_FILE" ]]; then
        echo "Error: --task-file not found: $TASK_FILE"
        exit 1
    fi
    TASK_DESC="$(cat "$TASK_FILE")"
fi

if [[ -z "$TASK_DESC" ]]; then
    echo "Error: --task or --task-file required"
    echo "Usage: spawn-agent.sh --task 'description' --repo /abs/path [--task-file /path/to/prompt.txt] [--agent codex|claude|gemini] [--host local|mac-mini|beelink2|auto] [--watchers '[{\"type\":\"session\",\"sessionKey\":\"agent:main:main\"}]'] [--target-upstream]"
    exit 1
fi

if [[ -z "$REPO_PATH" ]]; then
    echo "Error: --repo is required (guardrail: no implicit default repo)"
    exit 1
fi

# Encode task payload to avoid shell interpolation/injection during remote script transport
TASK_B64="$(printf '%s' "$TASK_DESC" | base64 -w0 2>/dev/null || printf '%s' "$TASK_DESC" | base64 | tr -d '\n')"

if [[ "$REPO_PATH" != /* ]]; then
    echo "Error: --repo must be an absolute path"
    exit 1
fi

# Load agent config
AGENT_CONFIG=$(jq -r ".${AGENT}" "$ROOT_DIR/config/agents.json")
if [[ "$AGENT_CONFIG" == "null" ]]; then
    echo "Error: Unknown agent '$AGENT'"
    exit 1
fi

AGENT_CMD=$(echo "$AGENT_CONFIG" | jq -r '.command')
AGENT_MODEL=$(echo "$AGENT_CONFIG" | jq -r '.model')
AGENT_FLAGS=$(echo "$AGENT_CONFIG" | jq -r '.flags[]?' | tr '\n' ' ')
AGENT_MODEL_FLAGS=$(echo "$AGENT_CONFIG" | jq -r '.modelFlags[]?' | tr '\n' ' ')
AGENT_INVOKE=$(echo "$AGENT_CONFIG" | jq -r '.invoke // "exec"')
PREFERRED_HOST=$(echo "$AGENT_CONFIG" | jq -r '.preferredHost')

# Guardrails: basic input hardening
if [[ -z "$TASK_FILE" && "$TASK_DESC" == *$'\n'* ]]; then
    echo "Error: --task must be a single line (use --task-file for multiline prompts)"
    exit 1
fi
if [[ "$REPO_PATH" =~ [\;\`\$\(\)] ]]; then
    echo "Error: --repo contains unsafe shell metacharacters"
    exit 1
fi

# Pre-flight fork-safety check: if repo has an upstream remote that is
# openclaw/openclaw and --target-upstream was not passed, refuse early.
_parse_github_repo_from_url() {
    local url="$1"
    local repo
    repo=$(echo "$url" | sed -E 's|.*github\.com[/:]([^/]+/[^/.]+)(\.git)?$|\1|')
    [[ "$repo" != "$url" ]] && echo "$repo" || echo ""
}

if [[ "$SWARM_PR_TARGET" != "upstream" ]] && command -v git >/dev/null 2>&1; then
    _upstream_url=$(git -C "$REPO_PATH" remote get-url upstream 2>/dev/null || true)
    if [[ -n "$_upstream_url" ]]; then
        _upstream_repo=$(_parse_github_repo_from_url "$_upstream_url")
        if [[ "$_upstream_repo" == "openclaw/openclaw" ]]; then
            echo "Error: upstream remote of '$REPO_PATH' is openclaw/openclaw."
            echo "       Refusing to spawn an agent that would PR to the upstream repo by default."
            echo "       Use --target-upstream to confirm you want to PR there."
            exit 1
        fi
    fi
fi

# Determine execution host
if [[ "$HOST" == "auto" ]]; then
    if [[ "$PREFERRED_HOST" == "mac-mini" ]]; then
        HOST="mac-mini"
    elif [[ "$PREFERRED_HOST" == "any" ]]; then
        HOST="local"
    else
        HOST="local"
    fi
fi

case "$HOST" in
    local|mac-mini|beelink2) ;;
    *)
        echo "Error: invalid --host '$HOST' (allowed: auto,local,mac-mini,beelink2)"
        exit 1
        ;;
esac

# Generate task ID
TASK_ID="${BRANCH_PREFIX}-$(date +%s)-$(head -c 4 /dev/urandom | xxd -p)"
BRANCH_NAME="${BRANCH_PREFIX}/${TASK_ID}"
WORKTREE_DIR="/tmp/agent-worktrees/${TASK_ID}"
TMUX_SESSION="agent-${TASK_ID}"

echo "==> Spawning ${AGENT} agent"
echo "    Task: ${TASK_DESC}"
echo "    ID: ${TASK_ID}"
echo "    Host: ${HOST}"
echo "    Repo: ${REPO_PATH}"
echo "    PR target: ${SWARM_PR_TARGET}"

# Function to execute on target host
execute_on_host() {
    local cmd="$1"
    
    if [[ "$HOST" == "local" ]]; then
        bash -c "$cmd"
    elif [[ "$HOST" == "mac-mini" ]]; then
        ssh adam@mac-mini.tailcd0984.ts.net "bash -lc '$cmd'"
    else
        ssh "$HOST" "bash -lc '$cmd'"
    fi
}

# Create worktree and launch agent
SPAWN_SCRIPT=$(cat <<'EOFSCRIPT'
set -euo pipefail

REPO_PATH="__REPO_PATH__"
WORKTREE_DIR="__WORKTREE_DIR__"
BRANCH_NAME="__BRANCH_NAME__"
TMUX_SESSION="__TMUX_SESSION__"
AGENT_CMD="__AGENT_CMD__"
AGENT_MODEL="__AGENT_MODEL__"
AGENT_FLAGS="__AGENT_FLAGS__"
AGENT_MODEL_FLAGS="__AGENT_MODEL_FLAGS__"
AGENT_INVOKE="__AGENT_INVOKE__"
TASK_B64="__TASK_B64__"
SWARM_PR_TARGET="__SWARM_PR_TARGET__"
TASK_DESC="$(printf '%s' "$TASK_B64" | base64 -d 2>/dev/null || printf '%s' "$TASK_B64" | base64 --decode 2>/dev/null || true)"

ORCH_INSTRUCTIONS="You are running inside an isolated git worktree created for this task. Do the requested work end-to-end.\n\nRequired completion protocol:\n1) Make the code/doc changes.\n2) Run relevant checks/tests for changed scope.\n3) Commit all changes with a clear commit message.\n4) If 'gh' is available and this repo has an origin remote, push branch and open a PR. ALWAYS target the fork (origin), not upstream. Steps:\n   a) Detect origin: ORIGIN_URL=\$(git remote get-url origin); ORIGIN_REPO=\$(echo \"\$ORIGIN_URL\" | sed -E 's|.*github\\.com[/:]([^/]+/[^/.]+)(\\.git)?\\$|\\1|')\n   b) Check upstream: UPSTREAM_REPO=\$(git remote get-url upstream 2>/dev/null | sed -E 's|.*github\\.com[/:]([^/]+/[^/.]+)(\\.git)?\\$|\\1|' || true)\n   c) If upstream exists, differs from origin, and env SWARM_PR_TARGET is not 'upstream':\n      - If upstream is openclaw/openclaw: print 'ERROR: refusing to PR to openclaw/openclaw upstream; set SWARM_PR_TARGET=upstream to confirm' and skip PR creation.\n      - Otherwise: note you are targeting origin fork.\n   d) Push and create PR: git push origin HEAD && gh pr create --repo \"\$ORIGIN_REPO\" --base main --title '...' --body '...'\n   e) If SWARM_PR_TARGET=upstream is set in env, targeting upstream is allowed.\n5) Print a concise completion summary including files changed and PR URL/number if created.\n6) If PR creation is not possible, explicitly state why and leave committed changes on this branch.\n\nBe decisive and avoid asking for interactive approvals; prefer finishing the task in one pass."

FULL_PROMPT="$ORCH_INSTRUCTIONS\n\nTask:\n$TASK_DESC"
SAFE_PROMPT=${FULL_PROMPT//\'/\'\"\'\"\'}
SAFE_PROMPT=${SAFE_PROMPT//$'\n'/\\n}

cd "$REPO_PATH"

# Create worktree
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME"

# Install dependencies if needed
cd "$WORKTREE_DIR"
if [[ -f "package.json" ]]; then
    npm install --silent 2>&1 | tail -5 || true
elif [[ -f "go.mod" ]]; then
    go mod download 2>&1 | tail -5 || true
fi

# Launch agent in tmux
tmux new-session -d -s "$TMUX_SESSION" -c "$WORKTREE_DIR"
# Export SWARM_PR_TARGET into the tmux session so the agent inherits it
tmux setenv -t "$TMUX_SESSION" SWARM_PR_TARGET "$SWARM_PR_TARGET"

case "$AGENT_INVOKE" in
  prompt)
    LAUNCH_CMD="SWARM_PR_TARGET=$SWARM_PR_TARGET $AGENT_CMD --model $AGENT_MODEL $AGENT_FLAGS $AGENT_MODEL_FLAGS -p '$SAFE_PROMPT'"
    ;;
  exec|*)
    LAUNCH_CMD="SWARM_PR_TARGET=$SWARM_PR_TARGET $AGENT_CMD --model $AGENT_MODEL $AGENT_FLAGS $AGENT_MODEL_FLAGS exec '$SAFE_PROMPT'"
    ;;
esac

tmux send-keys -t "$TMUX_SESSION" "$LAUNCH_CMD" Enter

echo "Agent spawned in tmux session: $TMUX_SESSION"
echo "Worktree: $WORKTREE_DIR"
echo "Branch: $BRANCH_NAME"
EOFSCRIPT
)

# Replace placeholders
SPAWN_SCRIPT="${SPAWN_SCRIPT//__REPO_PATH__/$REPO_PATH}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__WORKTREE_DIR__/$WORKTREE_DIR}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__BRANCH_NAME__/$BRANCH_NAME}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__TMUX_SESSION__/$TMUX_SESSION}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__AGENT_CMD__/$AGENT_CMD}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__AGENT_MODEL__/$AGENT_MODEL}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__AGENT_FLAGS__/$AGENT_FLAGS}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__AGENT_MODEL_FLAGS__/$AGENT_MODEL_FLAGS}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__AGENT_INVOKE__/$AGENT_INVOKE}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__TASK_B64__/$TASK_B64}"
SPAWN_SCRIPT="${SPAWN_SCRIPT//__SWARM_PR_TARGET__/$SWARM_PR_TARGET}"

# Execute spawn on target host
execute_on_host "$SPAWN_SCRIPT"

# Add to task registry (including optional watchers)
add_task "$TASK_ID" "$AGENT" "$REPO_PATH" "$BRANCH_NAME" "$WORKTREE_DIR" "$HOST" "$TMUX_SESSION" "$TASK_DESC" "$WATCHERS"

echo "==> Task registered: $TASK_ID"
echo "    Monitor: $SCRIPT_DIR/check-agents.sh"
echo "    Attach: tmux attach -t $TMUX_SESSION (on $HOST)"
echo "    Steer: tmux send-keys -t $TMUX_SESSION 'your guidance' Enter (on $HOST)"
