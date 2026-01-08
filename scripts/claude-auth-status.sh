#!/bin/bash
# Claude Code Authentication Status Checker
# Checks both Claude Code and Clawdbot auth status

set -euo pipefail

CLAUDE_CREDS="$HOME/.claude/.credentials.json"
CLAWDBOT_AUTH="$HOME/.clawdbot/agents/main/agent/auth-profiles.json"

# Colors for terminal output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Output mode: "full" (default), "json", or "simple"
OUTPUT_MODE="${1:-full}"

check_claude_code_auth() {
    if [ ! -f "$CLAUDE_CREDS" ]; then
        echo "MISSING"
        return 1
    fi

    local expires_at
    expires_at=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS")
    local now_ms=$(($(date +%s) * 1000))
    local diff_ms=$((expires_at - now_ms))
    local hours=$((diff_ms / 3600000))
    local mins=$(((diff_ms % 3600000) / 60000))

    if [ "$diff_ms" -lt 0 ]; then
        echo "EXPIRED"
        return 1
    elif [ "$diff_ms" -lt 3600000 ]; then
        echo "EXPIRING:${mins}m"
        return 2
    else
        echo "OK:${hours}h${mins}m"
        return 0
    fi
}

check_clawdbot_auth() {
    if [ ! -f "$CLAWDBOT_AUTH" ]; then
        echo "MISSING"
        return 1
    fi

    # Find the best Anthropic profile (prefer claude-cli, then any with latest expiry)
    local expires
    expires=$(jq -r '
        [.profiles | to_entries[] | select(.value.provider == "anthropic") | .value.expires]
        | max // 0
    ' "$CLAWDBOT_AUTH")

    local now_ms=$(($(date +%s) * 1000))
    local diff_ms=$((expires - now_ms))
    local hours=$((diff_ms / 3600000))
    local mins=$(((diff_ms % 3600000) / 60000))

    if [ "$diff_ms" -lt 0 ]; then
        echo "EXPIRED"
        return 1
    elif [ "$diff_ms" -lt 3600000 ]; then
        echo "EXPIRING:${mins}m"
        return 2
    else
        echo "OK:${hours}h${mins}m"
        return 0
    fi
}

# JSON output mode
if [ "$OUTPUT_MODE" = "json" ]; then
    claude_status=$(check_claude_code_auth 2>/dev/null || true)
    clawdbot_status=$(check_clawdbot_auth 2>/dev/null || true)

    claude_expires=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS" 2>/dev/null || echo "0")
    clawdbot_expires=$(jq -r '.profiles["anthropic:default"].expires // 0' "$CLAWDBOT_AUTH" 2>/dev/null || echo "0")

    jq -n \
        --arg cs "$claude_status" \
        --arg ce "$claude_expires" \
        --arg bs "$clawdbot_status" \
        --arg be "$clawdbot_expires" \
        '{
            claude_code: {status: $cs, expires_at_ms: ($ce | tonumber)},
            clawdbot: {status: $bs, expires_at_ms: ($be | tonumber)},
            needs_reauth: (($cs | startswith("EXPIRED") or startswith("EXPIRING") or startswith("MISSING")) or ($bs | startswith("EXPIRED") or startswith("EXPIRING") or startswith("MISSING")))
        }'
    exit 0
fi

# Simple output mode (for scripts/widgets)
if [ "$OUTPUT_MODE" = "simple" ]; then
    claude_status=$(check_claude_code_auth 2>/dev/null || true)
    clawdbot_status=$(check_clawdbot_auth 2>/dev/null || true)

    if [[ "$claude_status" == EXPIRED* ]] || [[ "$claude_status" == MISSING* ]]; then
        echo "CLAUDE_EXPIRED"
        exit 1
    elif [[ "$clawdbot_status" == EXPIRED* ]] || [[ "$clawdbot_status" == MISSING* ]]; then
        echo "CLAWDBOT_EXPIRED"
        exit 1
    elif [[ "$claude_status" == EXPIRING* ]]; then
        echo "CLAUDE_EXPIRING"
        exit 2
    elif [[ "$clawdbot_status" == EXPIRING* ]]; then
        echo "CLAWDBOT_EXPIRING"
        exit 2
    else
        echo "OK"
        exit 0
    fi
fi

# Full output mode (default)
echo "=== Claude Code Auth Status ==="
echo ""

# Claude Code credentials
echo "Claude Code (~/.claude/.credentials.json):"
if [ -f "$CLAUDE_CREDS" ]; then
    expires_at=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS")
    sub_type=$(jq -r '.claudeAiOauth.subscriptionType // "unknown"' "$CLAUDE_CREDS")
    rate_tier=$(jq -r '.claudeAiOauth.rateLimitTier // "unknown"' "$CLAUDE_CREDS")

    now_ms=$(($(date +%s) * 1000))
    diff_ms=$((expires_at - now_ms))
    hours=$((diff_ms / 3600000))
    mins=$(((diff_ms % 3600000) / 60000))

    echo "  Subscription: $sub_type"
    echo "  Rate tier: $rate_tier"

    if [ "$diff_ms" -lt 0 ]; then
        echo -e "  Status: ${RED}EXPIRED${NC}"
        echo "  Action needed: Run 'claude setup-token' or re-authenticate"
    elif [ "$diff_ms" -lt 3600000 ]; then
        echo -e "  Status: ${YELLOW}EXPIRING SOON (${mins}m remaining)${NC}"
        echo "  Consider running: claude setup-token"
    else
        echo -e "  Status: ${GREEN}OK${NC}"
        echo "  Expires: $(date -d @$((expires_at/1000))) (${hours}h ${mins}m)"
    fi
else
    echo -e "  Status: ${RED}NOT FOUND${NC}"
    echo "  Action needed: Run 'claude setup-token'"
fi

echo ""
echo "Clawdbot Auth (~/.clawdbot/agents/main/agent/auth-profiles.json):"
if [ -f "$CLAWDBOT_AUTH" ]; then
    # Find best Anthropic profile
    best_profile=$(jq -r '
        .profiles | to_entries
        | map(select(.value.provider == "anthropic"))
        | sort_by(.value.expires) | reverse
        | .[0].key // "none"
    ' "$CLAWDBOT_AUTH")

    expires=$(jq -r '
        [.profiles | to_entries[] | select(.value.provider == "anthropic") | .value.expires]
        | max // 0
    ' "$CLAWDBOT_AUTH")

    now_ms=$(($(date +%s) * 1000))
    diff_ms=$((expires - now_ms))
    hours=$((diff_ms / 3600000))
    mins=$(((diff_ms % 3600000) / 60000))

    echo "  Profile: $best_profile"

    if [ "$diff_ms" -lt 0 ]; then
        echo -e "  Status: ${RED}EXPIRED${NC}"
        echo "  Note: Run 'clawdbot doctor --yes' to sync from Claude Code"
    elif [ "$diff_ms" -lt 3600000 ]; then
        echo -e "  Status: ${YELLOW}EXPIRING SOON (${mins}m remaining)${NC}"
    else
        echo -e "  Status: ${GREEN}OK${NC}"
        echo "  Expires: $(date -d @$((expires/1000))) (${hours}h ${mins}m)"
    fi
else
    echo -e "  Status: ${RED}NOT FOUND${NC}"
fi

echo ""
echo "=== Service Status ==="
if systemctl --user is-active clawdbot >/dev/null 2>&1; then
    echo -e "Clawdbot service: ${GREEN}running${NC}"
else
    echo -e "Clawdbot service: ${RED}NOT running${NC}"
fi
