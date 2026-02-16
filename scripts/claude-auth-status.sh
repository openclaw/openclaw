#!/bin/bash
# Claude Code Authentication Status Checker
# Checks both Claude Code and SmartAgentNeo auth status

set -euo pipefail

CLAUDE_CREDS="$HOME/.claude/.credentials.json"
SMART_AGENT_NEO_AUTH="$HOME/.smart-agent-neo/agents/main/agent/auth-profiles.json"

# Colors for terminal output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Output mode: "full" (default), "json", or "simple"
OUTPUT_MODE="${1:-full}"

fetch_models_status_json() {
    smart-agent-neo models status --json 2>/dev/null || true
}

STATUS_JSON="$(fetch_models_status_json)"
USE_JSON=0
if [ -n "$STATUS_JSON" ]; then
    USE_JSON=1
fi

calc_status_from_expires() {
    local expires_at="$1"
    if ! [[ "$expires_at" =~ ^-?[0-9]+$ ]]; then
        expires_at=0
    fi
    local now_ms=$(( $(date +%s) * 1000 ))
    local diff_ms=$((expires_at - now_ms))
    local hours=$((diff_ms / 3600000))
    local mins=$(((diff_ms % 3600000) / 60000))

    if [ "$expires_at" -le 0 ]; then
        echo "MISSING"
        return 1
    elif [ "$diff_ms" -lt 0 ]; then
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

json_expires_for_claude_cli() {
    echo "$STATUS_JSON" | jq -r '
        [.auth.oauth.profiles[]
          | select(.provider == "anthropic" and (.type == "oauth" or .type == "token"))
          | .expiresAt // 0]
        | max // 0
    ' 2>/dev/null || echo "0"
}

json_expires_for_anthropic_any() {
    echo "$STATUS_JSON" | jq -r '
        [.auth.oauth.profiles[]
          | select(.provider == "anthropic" and .type == "oauth")
          | .expiresAt // 0]
        | max // 0
    ' 2>/dev/null || echo "0"
}

json_best_anthropic_profile() {
    echo "$STATUS_JSON" | jq -r '
        [.auth.oauth.profiles[]
          | select(.provider == "anthropic" and .type == "oauth")
          | {id: .profileId, exp: (.expiresAt // 0)}]
        | sort_by(.exp) | reverse | .[0].id // "none"
    ' 2>/dev/null || echo "none"
}

json_anthropic_api_key_count() {
    echo "$STATUS_JSON" | jq -r '
        [.auth.providers[] | select(.provider == "anthropic") | .profiles.apiKey]
        | max // 0
    ' 2>/dev/null || echo "0"
}

check_claude_code_auth() {
    if [ "$USE_JSON" -eq 1 ]; then
        local expires_at
        expires_at=$(json_expires_for_claude_cli)
        calc_status_from_expires "$expires_at"
        return $?
    fi

    if [ ! -f "$CLAUDE_CREDS" ]; then
        echo "MISSING"
        return 1
    fi

    local expires_at
    expires_at=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS" 2>/dev/null || echo "0")
    calc_status_from_expires "$expires_at"
}

check_smart-agent-neo_auth() {
    if [ "$USE_JSON" -eq 1 ]; then
        local api_keys
        api_keys=$(json_anthropic_api_key_count)
        if ! [[ "$api_keys" =~ ^[0-9]+$ ]]; then
            api_keys=0
        fi
        local expires_at
        expires_at=$(json_expires_for_anthropic_any)

        if [ "$expires_at" -le 0 ] && [ "$api_keys" -gt 0 ]; then
            echo "OK:static"
            return 0
        fi

        calc_status_from_expires "$expires_at"
        return $?
    fi

    if [ ! -f "$SMART_AGENT_NEO_AUTH" ]; then
        echo "MISSING"
        return 1
    fi

    local expires
    expires=$(jq -r '
        [.profiles | to_entries[] | select(.value.provider == "anthropic") | .value.expires]
        | max // 0
    ' "$SMART_AGENT_NEO_AUTH" 2>/dev/null || echo "0")

    calc_status_from_expires "$expires"
}

# JSON output mode
if [ "$OUTPUT_MODE" = "json" ]; then
    claude_status=$(check_claude_code_auth 2>/dev/null || true)
    smart-agent-neo_status=$(check_smart-agent-neo_auth 2>/dev/null || true)

    claude_expires=0
    smart-agent-neo_expires=0
    if [ "$USE_JSON" -eq 1 ]; then
        claude_expires=$(json_expires_for_claude_cli)
        smart-agent-neo_expires=$(json_expires_for_anthropic_any)
    else
        claude_expires=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS" 2>/dev/null || echo "0")
        smart-agent-neo_expires=$(jq -r '.profiles["anthropic:default"].expires // 0' "$SMART_AGENT_NEO_AUTH" 2>/dev/null || echo "0")
    fi

    jq -n \
        --arg cs "$claude_status" \
        --arg ce "$claude_expires" \
        --arg bs "$smart-agent-neo_status" \
        --arg be "$smart-agent-neo_expires" \
        '{
            claude_code: {status: $cs, expires_at_ms: ($ce | tonumber)},
            smart-agent-neo: {status: $bs, expires_at_ms: ($be | tonumber)},
            needs_reauth: (($cs | startswith("EXPIRED") or startswith("EXPIRING") or startswith("MISSING")) or ($bs | startswith("EXPIRED") or startswith("EXPIRING") or startswith("MISSING")))
        }'
    exit 0
fi

# Simple output mode (for scripts/widgets)
if [ "$OUTPUT_MODE" = "simple" ]; then
    claude_status=$(check_claude_code_auth 2>/dev/null || true)
    smart-agent-neo_status=$(check_smart-agent-neo_auth 2>/dev/null || true)

    if [[ "$claude_status" == EXPIRED* ]] || [[ "$claude_status" == MISSING* ]]; then
        echo "CLAUDE_EXPIRED"
        exit 1
    elif [[ "$smart-agent-neo_status" == EXPIRED* ]] || [[ "$smart-agent-neo_status" == MISSING* ]]; then
        echo "SMART_AGENT_NEO_EXPIRED"
        exit 1
    elif [[ "$claude_status" == EXPIRING* ]]; then
        echo "CLAUDE_EXPIRING"
        exit 2
    elif [[ "$smart-agent-neo_status" == EXPIRING* ]]; then
        echo "SMART_AGENT_NEO_EXPIRING"
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
if [ "$USE_JSON" -eq 1 ]; then
    expires_at=$(json_expires_for_claude_cli)
else
    expires_at=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS" 2>/dev/null || echo "0")
fi

if [ -f "$CLAUDE_CREDS" ]; then
    sub_type=$(jq -r '.claudeAiOauth.subscriptionType // "unknown"' "$CLAUDE_CREDS" 2>/dev/null || echo "unknown")
    rate_tier=$(jq -r '.claudeAiOauth.rateLimitTier // "unknown"' "$CLAUDE_CREDS" 2>/dev/null || echo "unknown")
    echo "  Subscription: $sub_type"
    echo "  Rate tier: $rate_tier"
fi

if [ "$expires_at" -le 0 ]; then
    echo -e "  Status: ${RED}NOT FOUND${NC}"
    echo "  Action needed: Run 'claude setup-token'"
else
    now_ms=$(( $(date +%s) * 1000 ))
    diff_ms=$((expires_at - now_ms))
    hours=$((diff_ms / 3600000))
    mins=$(((diff_ms % 3600000) / 60000))

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
fi

echo ""
echo "SmartAgentNeo Auth (~/.smart-agent-neo/agents/main/agent/auth-profiles.json):"
if [ "$USE_JSON" -eq 1 ]; then
    best_profile=$(json_best_anthropic_profile)
    expires=$(json_expires_for_anthropic_any)
    api_keys=$(json_anthropic_api_key_count)
else
    best_profile=$(jq -r '
        .profiles | to_entries
        | map(select(.value.provider == "anthropic"))
        | sort_by(.value.expires) | reverse
        | .[0].key // "none"
    ' "$SMART_AGENT_NEO_AUTH" 2>/dev/null || echo "none")
    expires=$(jq -r '
        [.profiles | to_entries[] | select(.value.provider == "anthropic") | .value.expires]
        | max // 0
    ' "$SMART_AGENT_NEO_AUTH" 2>/dev/null || echo "0")
    api_keys=0
fi

echo "  Profile: $best_profile"

if [ "$expires" -le 0 ] && [ "$api_keys" -gt 0 ]; then
    echo -e "  Status: ${GREEN}OK${NC} (API key)"
elif [ "$expires" -le 0 ]; then
    echo -e "  Status: ${RED}NOT FOUND${NC}"
    echo "  Note: Run 'smart-agent-neo doctor --yes' to sync from Claude Code"
else
    now_ms=$(( $(date +%s) * 1000 ))
    diff_ms=$((expires - now_ms))
    hours=$((diff_ms / 3600000))
    mins=$(((diff_ms % 3600000) / 60000))

    if [ "$diff_ms" -lt 0 ]; then
        echo -e "  Status: ${RED}EXPIRED${NC}"
        echo "  Note: Run 'smart-agent-neo doctor --yes' to sync from Claude Code"
    elif [ "$diff_ms" -lt 3600000 ]; then
        echo -e "  Status: ${YELLOW}EXPIRING SOON (${mins}m remaining)${NC}"
    else
        echo -e "  Status: ${GREEN}OK${NC}"
        echo "  Expires: $(date -d @$((expires/1000))) (${hours}h ${mins}m)"
    fi
fi

echo ""
echo "=== Service Status ==="
if systemctl --user is-active smart-agent-neo >/dev/null 2>&1; then
    echo -e "SmartAgentNeo service: ${GREEN}running${NC}"
else
    echo -e "SmartAgentNeo service: ${RED}NOT running${NC}"
fi
