#!/usr/bin/env bash
# delegate.sh — Launch Claude Code or Codex as a sub-process.
#
# Runs a delegation with API key stripping for security.
# Supports prompt strings, prompt files, foreground and background
# execution.
#
# Usage:
#   delegate.sh --prompt "Your task" [options]
#   delegate.sh --file /path/to/prompt.md [options]
#
# Options:
#   --prompt TEXT       Inline prompt string
#   --file PATH         Read prompt from file
#   --agent AGENT       "claude" (default) or "codex"
#   --workdir DIR       Working directory for the sub-process
#   --log PATH          Log file path (default: /tmp/delegation-<timestamp>.log)
#   --background        Run in background, return immediately
#   --full-auto         Codex: enable full-auto mode (default for codex)
#   --timeout SECS      Kill sub-process after N seconds (default: 3600)
#   -h, --help          Show this help message

set -euo pipefail

# --- Defaults ---
AGENT="claude"
PROMPT=""
PROMPT_FILE=""
WORKDIR="${PWD}"
LOG_FILE=""
BACKGROUND=false
FULL_AUTO=true
TIMEOUT=3600

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --prompt|--file|--agent|--workdir|--log|--timeout)
            if [[ $# -lt 2 ]]; then
                echo "Error: $1 requires a value" >&2
                exit 1
            fi
            ;;&
        --prompt)    PROMPT="$2"; shift 2 ;;
        --file)      PROMPT_FILE="$2"; shift 2 ;;
        --agent)     AGENT="$2"; shift 2 ;;
        --workdir)   WORKDIR="$2"; shift 2 ;;
        --log)       LOG_FILE="$2"; shift 2 ;;
        --background) BACKGROUND=true; shift ;;
        --full-auto) FULL_AUTO=true; shift ;;
        --no-full-auto) FULL_AUTO=false; shift ;;
        --timeout)   TIMEOUT="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# --- Validate ---
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

if [[ "$AGENT" != "claude" && "$AGENT" != "codex" ]]; then
    echo "Error: --agent must be 'claude' or 'codex'" >&2
    exit 1
fi

# Check agent binary exists
if ! command -v "$AGENT" &> /dev/null; then
    if [[ "$AGENT" == "claude" ]]; then
        echo "Error: 'claude' is not installed. Install with: npm install -g @anthropic-ai/claude-code" >&2
    else
        echo "Error: 'codex' is not installed. Install with: npm install -g @openai/codex" >&2
    fi
    exit 1
fi

# Check required utilities
if ! command -v timeout &> /dev/null; then
    echo "Error: 'timeout' is required but not found" >&2
    exit 1
fi

if [[ "$AGENT" == "codex" ]]; then
    if ! command -v script &> /dev/null; then
        echo "Error: 'script' (from util-linux) is required for Codex PTY support" >&2
        exit 1
    fi
    # BSD script (macOS) does not support -c flag
    if [[ "$(uname)" == "Darwin" ]]; then
        echo "Error: Codex delegation via delegate.sh requires Linux (GNU script)." >&2
        echo "On macOS, use tmux-session.sh or run Codex directly with a PTY." >&2
        exit 1
    fi
fi

if [[ ! -d "$WORKDIR" ]]; then
    echo "Error: working directory not found: $WORKDIR" >&2
    exit 1
fi

# Codex requires a git repository — fail fast instead of silently mutating
if [[ "$AGENT" == "codex" ]]; then
    if ! (cd "$WORKDIR" && { [[ -d .git ]] || git rev-parse --git-dir > /dev/null 2>&1; }); then
        echo "Error: Codex requires a git repository but $WORKDIR is not one." >&2
        echo "Initialize one with: cd $WORKDIR && git init" >&2
        exit 1
    fi
fi

# --- Set up log file ---
if [[ -z "$LOG_FILE" ]]; then
    LOG_FILE="/tmp/delegation-$(date +%s)-$$.log"
fi
mkdir -p "$(dirname "$LOG_FILE")"

# --- Strip AI provider credentials from environment ---
# Prevents key leakage to child processes. Forces subscription/OAuth auth.
for var in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY \
           AZURE_OPENAI_API_KEY COHERE_API_KEY MISTRAL_API_KEY OPENROUTER_API_KEY \
           DEEPSEEK_API_KEY TOGETHER_API_KEY FIREWORKS_API_KEY GROQ_API_KEY \
           GEMINI_API_KEY PERPLEXITY_API_KEY BRAVE_API_KEY BRAVE_SEARCH_API_KEY \
           REPLICATE_API_TOKEN AI21_API_KEY HUGGINGFACE_API_KEY HF_TOKEN \
           VOYAGE_API_KEY ANYSCALE_API_KEY XAI_API_KEY; do
    unset "$var" 2>/dev/null || true
done

# --- Build command ---
build_claude_cmd() {
    echo "claude --permission-mode bypassPermissions --print"
}

build_codex_cmd() {
    local cmd="codex exec"
    if $FULL_AUTO; then
        cmd="codex exec --full-auto"
    fi
    echo "$cmd"
}

run_delegation() {
    local exit_code=0

    cd "$WORKDIR" || exit 1

    case "$AGENT" in
        claude)
            $(build_claude_cmd) "$PROMPT" > "$LOG_FILE" 2>&1 || exit_code=$?
            ;;
        codex)
            # Codex requires a PTY — use script(1) to provide one.
            # -e: propagate child exit code (without it, script always returns 0)
            # Run through bash -c so printf '%q' quoting is interpreted correctly
            # (script passes commands to /bin/sh which may be dash, not bash).
            script -e -q -c "bash -c $(printf '%q' "$(build_codex_cmd) $(printf '%q' "$PROMPT")")" "$LOG_FILE" || exit_code=$?
            ;;
    esac

    return $exit_code
}

# --- Execute ---
echo "Delegating to $AGENT in $WORKDIR (timeout: ${TIMEOUT}s)"
echo "Log: $LOG_FILE"

ESCAPED_WORKDIR="$(printf '%q' "$WORKDIR")"
ESCAPED_LOG="$(printf '%q' "$LOG_FILE")"

if $BACKGROUND; then
    (
        EXIT_CODE=0
        timeout "$TIMEOUT" bash -c "$(declare -f run_delegation build_claude_cmd build_codex_cmd); \
            AGENT='$AGENT' PROMPT='$(printf '%s' "$PROMPT" | sed "s/'/'\\\\''/g")' \
            WORKDIR=$ESCAPED_WORKDIR LOG_FILE=$ESCAPED_LOG FULL_AUTO=$FULL_AUTO \
            run_delegation" || EXIT_CODE=$?
        echo ""
        echo "--- Delegation complete (exit code: $EXIT_CODE) ---"
    ) >> "$LOG_FILE" 2>&1 &
    BG_PID=$!
    echo "Background PID: $BG_PID"
    echo "Monitor: tail -f $LOG_FILE"
else
    EXIT_CODE=0
    timeout "$TIMEOUT" bash -c "$(declare -f run_delegation build_claude_cmd build_codex_cmd); \
        AGENT='$AGENT' PROMPT='$(printf '%s' "$PROMPT" | sed "s/'/'\\\\''/g")' \
        WORKDIR=$ESCAPED_WORKDIR LOG_FILE=$ESCAPED_LOG FULL_AUTO=$FULL_AUTO \
        run_delegation" || EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 0 ]]; then
        echo "Delegation complete."
    elif [[ $EXIT_CODE -eq 124 ]]; then
        echo "Delegation timed out after ${TIMEOUT}s. Check log: $LOG_FILE" >&2
    else
        echo "Delegation failed (exit code: $EXIT_CODE). Check log: $LOG_FILE" >&2
    fi
    exit $EXIT_CODE
fi
