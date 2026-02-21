#!/bin/bash
# =============================================================================
# aOa Status Line - Two-Line Progressive Display
# =============================================================================
#
# Line 1: user:directory (branch) +add/-del cc_version
# Line 2: ⚡ aOa 🟢 100% │ intents │ savings │ context │ Model
#
# =============================================================================

set -uo pipefail

AOA_URL="${AOA_URL:-http://localhost:8080}"
MIN_INTENTS=30

# Find AOA data directory from .aoa/home.json
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$HOOK_DIR")")"
AOA_HOME_FILE="$PROJECT_ROOT/.aoa/home.json"

if [ -f "$AOA_HOME_FILE" ]; then
    PROJECT_ID=$(jq -r '.project_id // ""' "$AOA_HOME_FILE" 2>/dev/null)
else
    PROJECT_ID=""
fi

# ANSI colors
CYAN='\033[96m'
GREEN='\033[92m'
YELLOW='\033[93m'
RED='\033[91m'
GRAY='\033[90m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'
MAGENTA='\033[95m'

# === READ INPUT FROM CLAUDE CODE ===
input=$(cat)

# === PARSE CONTEXT WINDOW ===
CURRENT_USAGE=$(echo "$input" | jq '.context_window.current_usage' 2>/dev/null)
CONTEXT_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size // 200000' 2>/dev/null)
MODEL=$(echo "$input" | jq -r '.model.display_name // "Unknown"' 2>/dev/null)
CWD=$(echo "$input" | jq -r '.cwd // ""' 2>/dev/null)

# === LINE 1: Environment Context ===
USERNAME="${USER:-$(whoami)}"

# Get git info if in a git repo
GIT_BRANCH=""
GIT_CHANGES=""
if [ -n "$CWD" ] && [ -d "$CWD/.git" ] || git -C "$CWD" rev-parse --git-dir >/dev/null 2>&1; then
    GIT_BRANCH=$(git -C "$CWD" symbolic-ref --short HEAD 2>/dev/null || git -C "$CWD" rev-parse --short HEAD 2>/dev/null)

    # Get insertions/deletions from staged + unstaged changes
    GIT_STAT=$(git -C "$CWD" diff --shortstat HEAD 2>/dev/null)
    if [ -n "$GIT_STAT" ]; then
        INSERTIONS=$(echo "$GIT_STAT" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
        DELETIONS=$(echo "$GIT_STAT" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo "0")
        [ -z "$INSERTIONS" ] && INSERTIONS=0
        [ -z "$DELETIONS" ] && DELETIONS=0
        if [ "$INSERTIONS" -gt 0 ] || [ "$DELETIONS" -gt 0 ]; then
            GIT_CHANGES="${GREEN}+${INSERTIONS}${RESET}/${RED}-${DELETIONS}${RESET}"
        fi
    fi
fi

# Get Claude Code version from CLI
CC_VERSION=$(claude --version 2>/dev/null | grep -oP '[\d.]+' | head -1 || echo "")
CC_VER_DISPLAY=""
if [ -n "$CC_VERSION" ]; then
    CC_VER_DISPLAY="${DIM}cc${RESET}${CYAN}${CC_VERSION}${RESET}"
fi

# Build Line 1
LINE1="${MAGENTA}${USERNAME}${RESET}:${CYAN}${CWD}${RESET}"
if [ -n "$GIT_BRANCH" ]; then
    LINE1="${LINE1} ${DIM}(${RESET}${YELLOW}${GIT_BRANCH}${RESET}${DIM})${RESET}"
fi
if [ -n "$GIT_CHANGES" ]; then
    LINE1="${LINE1} ${GIT_CHANGES}"
fi
if [ -n "$CC_VER_DISPLAY" ]; then
    LINE1="${LINE1} ${DIM}${CC_VER_DISPLAY}${RESET}"
fi

# Format CWD (show last 2 path components) - for compact display
if [ -n "$CWD" ]; then
    CWD_SHORT=$(echo "$CWD" | rev | cut -d'/' -f1-2 | rev)
else
    CWD_SHORT=""
fi

# Get tokens
if [ "$CURRENT_USAGE" != "null" ] && [ -n "$CURRENT_USAGE" ]; then
    INPUT_TOKENS=$(echo "$CURRENT_USAGE" | jq -r '.input_tokens // 0')
    CACHE_CREATION=$(echo "$CURRENT_USAGE" | jq -r '.cache_creation_input_tokens // 0')
    CACHE_READ=$(echo "$CURRENT_USAGE" | jq -r '.cache_read_input_tokens // 0')
    TOTAL_TOKENS=$((INPUT_TOKENS + CACHE_CREATION + CACHE_READ))
else
    TOTAL_TOKENS=0
fi

# Ensure numeric
CONTEXT_SIZE=${CONTEXT_SIZE:-200000}
[ "$CONTEXT_SIZE" -eq 0 ] 2>/dev/null && CONTEXT_SIZE=200000
TOTAL_TOKENS=${TOTAL_TOKENS:-0}

# Calculate percentage
if [ "$CONTEXT_SIZE" -gt 0 ]; then
    PERCENT=$((TOTAL_TOKENS * 100 / CONTEXT_SIZE))
else
    PERCENT=0
fi

# Format tokens (e.g., 51k, 1.2M)
format_tokens() {
    local n=$1
    if [ "$n" -ge 1000000 ]; then
        local m=$((n / 1000000))
        local k=$(( (n % 1000000) / 100000 ))
        if [ "$k" -gt 0 ]; then
            echo "${m}.${k}M"
        else
            echo "${m}M"
        fi
    elif [ "$n" -ge 1000 ]; then
        local k=$((n / 1000))
        echo "${k}k"
    else
        echo "$n"
    fi
}

# Format time (seconds to human readable)
format_time() {
    local sec=$1
    if [ "$sec" -ge 3600 ]; then
        local h=$((sec / 3600))
        local m=$(( (sec % 3600) / 60 ))
        echo "${h}h${m}m"
    elif [ "$sec" -ge 60 ]; then
        local m=$((sec / 60))
        local s=$((sec % 60))
        echo "${m}m${s}s"
    else
        echo "${sec}s"
    fi
}

TOTAL_FMT=$(format_tokens $TOTAL_TOKENS)
CTX_SIZE_FMT=$(format_tokens $CONTEXT_SIZE)

# Context color
if [ "$PERCENT" -lt 50 ]; then CTX_COLOR=$GREEN
elif [ "$PERCENT" -lt 75 ]; then CTX_COLOR=$YELLOW
else CTX_COLOR=$RED
fi

# === GET AOA METRICS (with timing) ===
START_TIME=$(date +%s%N)
# Include project_id for per-project metrics
METRICS_URL="${AOA_URL}/metrics"
if [ -n "$PROJECT_ID" ]; then
    METRICS_URL="${METRICS_URL}?project_id=${PROJECT_ID}"
fi
METRICS=$(curl -s --max-time 0.3 "${METRICS_URL}" 2>/dev/null)
END_TIME=$(date +%s%N)

# Calculate response time in ms
if [ -n "$METRICS" ]; then
    RESPONSE_MS=$(( (END_TIME - START_TIME) / 1000000 ))
else
    RESPONSE_MS=0
fi

if [ -z "$METRICS" ]; then
    # aOa not running - minimal output (still show both lines)
    echo -e "${LINE1}"
    echo -e "${CYAN}${BOLD}⚡ aOa${RESET} ${DIM}offline${RESET} ${DIM}│${RESET} ctx:${CTX_COLOR}${TOTAL_FMT}/${CTX_SIZE_FMT}${RESET} ${DIM}(${PERCENT}%)${RESET} ${DIM}│${RESET} ${MODEL}"
    exit 0
fi

# Parse metrics
HIT_PCT=$(echo "$METRICS" | jq -r '.rolling.hit_at_5_pct // 0')
HIT_PCT_INT=$(printf "%.0f" "$HIT_PCT")
TOKENS_SAVED=$(echo "$METRICS" | jq -r '.savings.tokens // 0')
ROLLING_HITS=$(echo "$METRICS" | jq -r '.rolling.hits // 0')
EVALUATED=$(echo "$METRICS" | jq -r '.rolling.evaluated // 0')

# Calculate dynamic time savings using rolling average (same as aoa intent)
TIME_SAVED_SEC_INT=0
if [ "$TOKENS_SAVED" -gt 0 ] 2>/dev/null; then
    RATE_MS=$(python3 -c "
import json, os
from pathlib import Path
from datetime import datetime
home = os.path.expanduser('~')
pd = Path(home) / '.claude' / 'projects'
if not pd.exists(): print('4'); exit()
sessions = []
for d in sorted(pd.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:2]:
    sessions.extend(sorted(d.glob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)[:3])
now = datetime.now().astimezone()
rates = []
for sf in sessions[:5]:
    try:
        msgs = []
        for line in open(sf):
            try:
                e = json.loads(line.strip())
                if e.get('type') == 'assistant' and 'message' in e:
                    m = e['message']
                    if 'usage' in m and 'timestamp' in e:
                        ts = datetime.fromisoformat(e['timestamp'].replace('Z', '+00:00'))
                        tok = m['usage'].get('input_tokens', 0) + m['usage'].get('output_tokens', 0)
                        msgs.append((ts, tok))
            except: pass
        for i in range(1, len(msgs)):
            dur = (msgs[i][0] - msgs[i-1][0]).total_seconds() * 1000
            tok = msgs[i][1]
            age = (now - msgs[i][0]).total_seconds() / 60
            if 100 < dur < 15000 and tok > 200 and age <= 30:
                r = dur / tok
                if r < 20: rates.append(r)
    except: pass
if rates:
    rates.sort()
    print(round(rates[len(rates)//4], 1))
else:
    print('4')
" 2>/dev/null)
    RATE_MS=${RATE_MS:-4}
    TIME_SAVED_SEC_INT=$(awk "BEGIN {printf \"%.0f\", $TOKENS_SAVED * $RATE_MS / 1000}")
fi

# Get intent count from API (per-project)
INTENT_URL="${AOA_URL}/intent/stats"
if [ -n "$PROJECT_ID" ]; then
    INTENT_URL="${INTENT_URL}?project_id=${PROJECT_ID}"
fi
INTENT_STATS=$(curl -s --max-time 0.2 "${INTENT_URL}" 2>/dev/null)
INTENTS=$(echo "$INTENT_STATS" | jq -r '.total_records // 0' 2>/dev/null)
INTENTS=${INTENTS:-0}

# === BUILD DISPLAY ===
SEP="${DIM}│${RESET}"

# Traffic light + intents
if [ "$INTENTS" -lt "$MIN_INTENTS" ]; then
    # Learning phase: gray light, X/30
    LIGHT="${GRAY}⚪${RESET}"
    INTENT_DISPLAY="${INTENTS}/${MIN_INTENTS}"
elif [ "$HIT_PCT_INT" -ge 80 ] 2>/dev/null; then
    # Good predictions: green light
    LIGHT="${GREEN}🟢${RESET}"
    INTENT_DISPLAY="${INTENTS}"
else
    # Predicting but room to improve: yellow light
    LIGHT="${YELLOW}🟡${RESET}"
    INTENT_DISPLAY="${INTENTS}"
fi

# Format intents for display (1.2k for large numbers)
if [ "$INTENTS" -ge 1000 ]; then
    INTENT_FMT=$(format_tokens $INTENTS)
    if [ "$INTENTS" -lt "$MIN_INTENTS" ]; then
        INTENT_DISPLAY="${INTENT_FMT}/${MIN_INTENTS}"
    else
        INTENT_DISPLAY="${INTENT_FMT}"
    fi
fi

# Middle section: savings OR speed+hits
if [ "$TOKENS_SAVED" -gt 0 ] 2>/dev/null; then
    # Have savings - show them
    TOKENS_SAVED_FMT=$(format_tokens $TOKENS_SAVED)
    TIME_SAVED_FMT=$(format_time $TIME_SAVED_SEC_INT)
    MIDDLE="${GREEN}↓${TOKENS_SAVED_FMT}${RESET} ${GREEN}⚡${TIME_SAVED_FMT}${RESET} saved"
else
    # No savings yet - show speed and prediction hits
    HITS=${ROLLING_HITS:-0}
    if [ "$HITS" -gt 0 ]; then
        MIDDLE="${GREEN}${RESPONSE_MS}ms${RESET} ${DIM}•${RESET} ${HITS} hits"
    else
        MIDDLE="${GREEN}${RESPONSE_MS}ms${RESET} ${DIM}•${RESET} ready"
    fi
fi

# === OUTPUT ===
# Line 1: Environment context
echo -e "${LINE1}"

# Line 2: aOa status
echo -e "${CYAN}${BOLD}⚡ aOa${RESET} ${LIGHT} ${INTENT_DISPLAY} ${SEP} ${MIDDLE} ${SEP} ctx:${CTX_COLOR}${TOTAL_FMT}/${CTX_SIZE_FMT}${RESET} ${DIM}(${PERCENT}%)${RESET} ${SEP} ${MODEL}"
