#!/usr/bin/env bash
# tmux-session.sh — Manage long-running Claude Code / Codex delegations in tmux.
#
# Usage:
#   tmux-session.sh --name SESSION --prompt "task" [options]
#   tmux-session.sh --attach SESSION
#   tmux-session.sh --status SESSION
#   tmux-session.sh --list
#   tmux-session.sh --kill SESSION
#
# Options:
#   --name NAME         Session name (required for new sessions)
#   --prompt TEXT        Task prompt
#   --file PATH         Read prompt from file (alternative to --prompt)
#   --agent AGENT       "claude" (default) or "codex"
#   --workdir DIR       Working directory (default: current directory)
#   --attach NAME       Attach to an existing session
#   --status NAME       Check if a session is active and show last output
#   --list              List all delegation sessions
#   --kill NAME         Kill a session
#   -h, --help          Show this help message

set -euo pipefail

SESSION_PREFIX="delegation"
ACTION=""
SESSION_NAME=""
AGENT="claude"
PROMPT=""
PROMPT_FILE=""
WORKDIR="${PWD}"

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --name|--prompt|--file|--agent|--workdir|--attach|--status|--kill)
            if [[ $# -lt 2 ]]; then
                echo "Error: $1 requires a value" >&2
                exit 1
            fi
            ;;&
        --name)     SESSION_NAME="$2"; ACTION="${ACTION:-create}"; shift 2 ;;
        --prompt)   PROMPT="$2"; shift 2 ;;
        --file)     PROMPT_FILE="$2"; shift 2 ;;
        --agent)    AGENT="$2"; shift 2 ;;
        --workdir)  WORKDIR="$2"; shift 2 ;;
        --attach)   ACTION="attach"; SESSION_NAME="$2"; shift 2 ;;
        --status)   ACTION="status"; SESSION_NAME="$2"; shift 2 ;;
        --list)     ACTION="list"; shift ;;
        --kill)     ACTION="kill"; SESSION_NAME="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# --- Check tmux ---
if ! command -v tmux &> /dev/null; then
    echo "Error: tmux is not installed" >&2
    exit 1
fi

full_session_name() {
    echo "${SESSION_PREFIX}-${1}"
}

# --- Actions ---
case "$ACTION" in
    list)
        echo "Active delegation sessions:"
        tmux list-sessions -F '#{session_name} (created #{session_created_string})' 2>/dev/null \
            | grep "^${SESSION_PREFIX}-" \
            | sed "s/^${SESSION_PREFIX}-/  /" \
            || echo "  (none)"
        ;;

    status)
        FULL_NAME="$(full_session_name "$SESSION_NAME")"
        if tmux has-session -t "$FULL_NAME" 2>/dev/null; then
            echo "Session '$SESSION_NAME' is active."
            echo ""
            echo "--- Last 20 lines of output ---"
            tmux capture-pane -t "$FULL_NAME" -p | tail -20
        else
            echo "Session '$SESSION_NAME' is not running."
        fi
        ;;

    attach)
        FULL_NAME="$(full_session_name "$SESSION_NAME")"
        if tmux has-session -t "$FULL_NAME" 2>/dev/null; then
            tmux attach -t "$FULL_NAME"
        else
            echo "Session '$SESSION_NAME' not found." >&2
            exit 1
        fi
        ;;

    kill)
        FULL_NAME="$(full_session_name "$SESSION_NAME")"
        if tmux has-session -t "$FULL_NAME" 2>/dev/null; then
            tmux kill-session -t "$FULL_NAME"
            echo "Session '$SESSION_NAME' killed."
        else
            echo "Session '$SESSION_NAME' not found." >&2
            exit 1
        fi
        ;;

    create)
        if [[ -z "$SESSION_NAME" ]]; then
            echo "Error: --name is required" >&2
            exit 1
        fi

        # Check agent binary exists
        if ! command -v "$AGENT" &> /dev/null; then
            echo "Error: '$AGENT' is not installed. Install with: npm install -g @anthropic-ai/claude-code (or @openai/codex)" >&2
            exit 1
        fi

        if [[ ! -d "$WORKDIR" ]]; then
            echo "Error: working directory not found: $WORKDIR" >&2
            exit 1
        fi

        # Codex requires a git repo
        if [[ "$AGENT" == "codex" ]]; then
            cd "$WORKDIR"
            if [[ ! -d .git ]] && ! git rev-parse --git-dir > /dev/null 2>&1; then
                echo "Error: Codex requires a git repository but $WORKDIR is not one." >&2
                echo "Initialize one with: cd $WORKDIR && git init" >&2
                exit 1
            fi
        fi

        if [[ -z "$PROMPT" && -z "$PROMPT_FILE" ]]; then
            echo "Error: --prompt or --file is required" >&2
            exit 1
        fi

        if [[ -n "$PROMPT_FILE" ]]; then
            if [[ ! -f "$PROMPT_FILE" ]]; then
                echo "Error: prompt file not found: $PROMPT_FILE" >&2
                exit 1
            fi
            PROMPT="$(cat "$PROMPT_FILE")"
        fi

        if [[ -z "$PROMPT" ]]; then
            echo "Error: prompt is empty" >&2
            exit 1
        fi

        FULL_NAME="$(full_session_name "$SESSION_NAME")"

        if tmux has-session -t "$FULL_NAME" 2>/dev/null; then
            echo "Session '$SESSION_NAME' already exists. Use --attach or --kill first." >&2
            exit 1
        fi

        # Strip AI provider credentials from environment
        STRIP_VARS="ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY"
        STRIP_VARS="$STRIP_VARS AZURE_OPENAI_API_KEY COHERE_API_KEY MISTRAL_API_KEY OPENROUTER_API_KEY"
        STRIP_VARS="$STRIP_VARS DEEPSEEK_API_KEY TOGETHER_API_KEY FIREWORKS_API_KEY GROQ_API_KEY"
        STRIP_VARS="$STRIP_VARS GEMINI_API_KEY PERPLEXITY_API_KEY BRAVE_API_KEY BRAVE_SEARCH_API_KEY"
        STRIP_VARS="$STRIP_VARS REPLICATE_API_TOKEN AI21_API_KEY HUGGINGFACE_API_KEY HF_TOKEN"
        STRIP_VARS="$STRIP_VARS VOYAGE_API_KEY ANYSCALE_API_KEY XAI_API_KEY"
        ENV_STRIP=""
        for v in $STRIP_VARS; do ENV_STRIP="$ENV_STRIP -u $v"; done

        # Build the command
        case "$AGENT" in
            claude)
                CMD="cd $(printf '%q' "$WORKDIR") && env $ENV_STRIP claude --permission-mode bypassPermissions --print $(printf '%q' "$PROMPT")"
                ;;
            codex)
                CMD="cd $(printf '%q' "$WORKDIR") && env $ENV_STRIP codex exec --full-auto $(printf '%q' "$PROMPT")"
                ;;
            *)
                echo "Error: --agent must be 'claude' or 'codex'" >&2
                exit 1
                ;;
        esac

        tmux new-session -d -s "$FULL_NAME" -c "$WORKDIR" "$CMD; echo ''; echo '--- Session complete. Press Enter to close. ---'; read"
        echo "Session '$SESSION_NAME' started."
        echo "  Attach:  $0 --attach $SESSION_NAME"
        echo "  Status:  $0 --status $SESSION_NAME"
        echo "  Kill:    $0 --kill $SESSION_NAME"
        ;;

    *)
        echo "Error: specify an action (--name, --attach, --status, --list, --kill)" >&2
        echo "Run with --help for usage." >&2
        exit 1
        ;;
esac
