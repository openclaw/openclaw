#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Output mode: "full" (default), "json", or "simple"
OUTPUT_MODE="${1:-full}"

STATUS_AVAILABLE=1
if ! STATUS_JSON="$(openclaw models status --json 2>/dev/null)" || [ -z "$STATUS_JSON" ]; then
    STATUS_AVAILABLE=0
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

format_epoch_seconds() {
    local epoch_seconds="$1"
    date -r "$epoch_seconds" 2>/dev/null || date -d "@$epoch_seconds"
}

print_full_expiry() {
    local expires_at="$1" expired_hint="$2" expiring_hint="${3:-}"
    local now_ms=$(( $(date +%s) * 1000 ))
    local diff_ms=$((expires_at - now_ms))
    local hours=$((diff_ms / 3600000))
    local mins=$(((diff_ms % 3600000) / 60000))

    if [ "$diff_ms" -lt 0 ]; then
        echo -e "  Status: ${RED}EXPIRED${NC}"
        echo "$expired_hint"
    elif [ "$diff_ms" -lt 3600000 ]; then
        echo -e "  Status: ${YELLOW}EXPIRING SOON (${mins}m remaining)${NC}"
        if [ -n "$expiring_hint" ]; then
            echo "$expiring_hint"
        fi
    else
        echo -e "  Status: ${GREEN}OK${NC}"
        echo "  Expires: $(format_epoch_seconds "$((expires_at/1000))") (${hours}h ${mins}m)"
    fi
}

json_native_route() {
    echo "$STATUS_JSON" | jq -c '
        [.auth.runtimeAuthRoutes[]?
          | select(.nativeAuth.runtimeId == "claude-cli" and .nativeAuth.mode == "oauth")]
        | .[0] // {}
    '
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

claude_status="UNKNOWN"
native_readiness="unknown"
native_message=""
native_route_status=""
openclaw_status="UNKNOWN"
openclaw_expires=0
best_profile="none"
api_keys=0

if [ "$STATUS_AVAILABLE" -eq 1 ]; then
    native_route=$(json_native_route)
    native_readiness=$(echo "$native_route" | jq -r '.nativeAuth.readiness // "unknown"')
    native_message=$(echo "$native_route" | jq -r '.nativeAuth.message // ""')
    native_route_status=$(echo "$native_route" | jq -r '.status // ""')
    case "$native_readiness" in
        configured) claude_status="OK:configured" ;;
        missing) claude_status="MISSING" ;;
    esac

    openclaw_expires=$(json_expires_for_anthropic_any)
    best_profile=$(json_best_anthropic_profile)
    api_keys=$(json_anthropic_api_key_count)
    if [ "$openclaw_expires" -le 0 ] && [ "$api_keys" -gt 0 ]; then
        openclaw_status="OK:static"
    elif [ "$best_profile" != "none" ]; then
        openclaw_status=$(calc_status_from_expires "$openclaw_expires" || true)
    elif [ "$native_route_status" = "usable" ]; then
        openclaw_status="OK:native"
    elif [ "$claude_status" = "MISSING" ]; then
        openclaw_status="MISSING"
    elif [ "$(echo "$STATUS_JSON" | jq -r '(.auth.missingProvidersInUse // []) | index("anthropic") != null')" = "true" ]; then
        openclaw_status="MISSING"
    fi
fi

if [ "$OUTPUT_MODE" = "json" ]; then

    jq -n \
        --arg cs "$claude_status" \
        --arg nr "$native_readiness" \
        --arg nm "$native_message" \
        --arg bs "$openclaw_status" \
        --arg be "$openclaw_expires" \
        '{
            claude_code: {status: $cs, expires_at_ms: 0, readiness: $nr, message: $nm},
            openclaw: {status: $bs, expires_at_ms: ($be | tonumber)},
            needs_reauth: (($cs | startswith("EXPIRED") or startswith("EXPIRING") or startswith("MISSING")) or ($bs | startswith("EXPIRED") or startswith("EXPIRING") or startswith("MISSING")))
        }'
    if [ "$STATUS_AVAILABLE" -eq 0 ]; then
        exit 3
    fi
    exit 0
fi

if [ "$OUTPUT_MODE" = "simple" ]; then
    if [ "$STATUS_AVAILABLE" -eq 0 ]; then
        echo "UNKNOWN"
        exit 3
    elif [[ "$claude_status" == MISSING* ]]; then
        echo "CLAUDE_EXPIRED"
        exit 1
    elif [[ "$openclaw_status" == EXPIRED* ]] || [[ "$openclaw_status" == MISSING* ]]; then
        echo "OPENCLAW_EXPIRED"
        exit 1
    elif [[ "$openclaw_status" == EXPIRING* ]]; then
        echo "OPENCLAW_EXPIRING"
        exit 2
    elif [ "$openclaw_status" = "UNKNOWN" ]; then
        echo "UNKNOWN"
        exit 3
    else
        echo "OK"
        exit 0
    fi
fi

echo "=== Claude Code Auth Status ==="
echo ""

echo "Claude Code (native CLI):"
case "$claude_status" in
    OK:*) echo -e "  Status: ${GREEN}CONFIGURED${NC} (Claude Code manages login and refresh)" ;;
    MISSING) echo -e "  Status: ${RED}NOT FOUND${NC}" ;;
    *) echo -e "  Status: ${YELLOW}UNKNOWN${NC}" ;;
esac
if [ -n "$native_message" ]; then
    printf '  %s\n' "$native_message"
fi

echo ""
echo "OpenClaw Auth (managed Anthropic profiles):"
echo "  Profile: $best_profile"
case "$openclaw_status" in
    OK:static) echo -e "  Status: ${GREEN}OK${NC} (API key)" ;;
    OK:native) echo -e "  Status: ${GREEN}OK${NC} (native Claude Code route)" ;;
    UNKNOWN) echo -e "  Status: ${YELLOW}UNKNOWN${NC}" ;;
    MISSING)
        echo -e "  Status: ${RED}NOT FOUND${NC}"
        if [ "$best_profile" != "none" ] || [ "$claude_status" != "MISSING" ]; then
            echo "  Action needed: Configure managed Anthropic authentication with 'openclaw models auth'."
        fi
        ;;
    *)
        print_full_expiry "$openclaw_expires" \
            "  Action needed: Renew managed Anthropic authentication with 'openclaw models auth'."
        ;;
esac

if [ "$STATUS_AVAILABLE" -eq 0 ]; then
    echo ""
    echo "Unable to read authentication status from 'openclaw models status --json'."
    exit 3
fi

echo ""
echo "=== Service Status ==="
if systemctl --user is-active openclaw >/dev/null 2>&1; then
    echo -e "OpenClaw service: ${GREEN}running${NC}"
else
    echo -e "OpenClaw service: ${RED}NOT running${NC}"
fi
