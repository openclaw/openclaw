#!/bin/bash
# Claude Code Authentication Status Checker
# Checks both Claude Code and OpenClaw auth status

set -euo pipefail

SHARED_CLAUDE_HOME="${OPENCLAW_SHARED_CLAUDE_HOME:-/data/agent-state/claude-home}"
OPENCLAW_AUTH="${OPENCLAW_AUTH:-$HOME/.openclaw/agents/main/agent/auth-profiles.json}"

resolve_claude_creds() {
    if [ -n "${CLAUDE_CREDS:-}" ]; then
        printf '%s\n' "$CLAUDE_CREDS"
        return
    fi
    for candidate in \
        "${CLAUDE_CONFIG_DIR:-}/.credentials.json" \
        "${CLAUDE_CONFIG_DIR:-}/.claude/.credentials.json" \
        "$SHARED_CLAUDE_HOME/.credentials.json" \
        "$SHARED_CLAUDE_HOME/.claude/.credentials.json" \
        "$HOME/.claude/.credentials.json" \
        "$HOME/.credentials.json"
    do
        if [ -n "$candidate" ] && [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return
        fi
    done
    printf '%s\n' "$SHARED_CLAUDE_HOME/.credentials.json"
}

CLAUDE_CREDS="$(resolve_claude_creds)"

claude_creds_value() {
    local field="$1"
    local default_value="$2"
    python3 - "$CLAUDE_CREDS" "$field" "$default_value" <<'PY'
import json
import sys

path, field, default = sys.argv[1:4]
try:
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    for part in field.split("."):
        value = value[part]
except Exception:
    print(default)
else:
    if value is None or isinstance(value, (dict, list)):
        print(default)
    else:
        print(value)
PY
}

status_json_value() {
    local kind="$1"
    STATUS_JSON_PAYLOAD="$STATUS_JSON" python3 - "$kind" <<'PY'
import json
import os
import sys

kind = sys.argv[1]
try:
    data = json.loads(os.environ.get("STATUS_JSON_PAYLOAD") or "{}")
except json.JSONDecodeError:
    data = {}

profiles = (((data.get("auth") or {}).get("oauth") or {}).get("profiles") or [])
providers = ((data.get("auth") or {}).get("providers") or [])

if kind == "claude_expires":
    values = [
        int(item.get("expiresAt") or 0)
        for item in profiles
        if item.get("provider") == "anthropic" and item.get("type") in {"oauth", "token"}
    ]
    print(max(values) if values else 0)
elif kind == "anthropic_any_expires":
    values = [
        int(item.get("expiresAt") or 0)
        for item in profiles
        if item.get("provider") == "anthropic" and item.get("type") == "oauth"
    ]
    print(max(values) if values else 0)
elif kind == "best_profile":
    values = [
        (int(item.get("expiresAt") or 0), str(item.get("profileId") or "none"))
        for item in profiles
        if item.get("provider") == "anthropic" and item.get("type") == "oauth"
    ]
    print(max(values)[1] if values else "none")
elif kind == "api_key_count":
    values = []
    for item in providers:
        if item.get("provider") != "anthropic":
            continue
        raw_value = (item.get("profiles") or {}).get("apiKey") or 0
        try:
            values.append(int(raw_value))
        except (TypeError, ValueError):
            pass
    print(max(values) if values else 0)
elif kind == "anthropic_oauth_count":
    values = [
        item
        for item in profiles
        if item.get("provider") == "anthropic" and item.get("type") == "oauth"
    ]
    print(len(values))
else:
    print(0)
PY
}

openclaw_auth_value() {
    local kind="$1"
    python3 - "$OPENCLAW_AUTH" "$kind" <<'PY'
import json
import sys

path, kind = sys.argv[1:3]
try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    data = {}

profiles = data.get("profiles") or {}
anthropic = [
    (profile_id, value)
    for profile_id, value in profiles.items()
    if isinstance(value, dict) and value.get("provider") == "anthropic"
]

if kind == "default_expires":
    print(int((profiles.get("anthropic:default") or {}).get("expires") or 0))
elif kind == "max_expires":
    values = []
    for _, value in anthropic:
        try:
            values.append(int(value.get("expires") or 0))
        except (TypeError, ValueError):
            pass
    print(max(values) if values else 0)
elif kind == "best_profile":
    values = []
    for profile_id, value in anthropic:
        try:
            values.append((int(value.get("expires") or 0), profile_id))
        except (TypeError, ValueError):
            pass
    print(max(values)[1] if values else "none")
elif kind == "anthropic_count":
    print(len(anthropic))
else:
    print(0)
PY
}

emit_status_json() {
    local claude_status="$1"
    local claude_expires="$2"
    local openclaw_status="$3"
    local openclaw_expires="$4"
    python3 - "$claude_status" "$claude_expires" "$openclaw_status" "$openclaw_expires" <<'PY'
import json
import sys

claude_status, claude_expires, openclaw_status, openclaw_expires = sys.argv[1:5]
needs_reauth = any(
    status.startswith(("EXPIRED", "EXPIRING", "MISSING"))
    for status in (claude_status, openclaw_status)
)

def as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0

print(json.dumps({
    "claude_code": {
        "status": claude_status,
        "expires_at_ms": as_int(claude_expires),
    },
    "openclaw": {
        "status": openclaw_status,
        "expires_at_ms": as_int(openclaw_expires),
    },
    "needs_reauth": needs_reauth,
}, indent=2))
PY
}

# Colors for terminal output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Output mode: "full" (default), "json", or "simple"
OUTPUT_MODE="${1:-full}"

fetch_models_status_json() {
    openclaw models status --json 2>/dev/null || true
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

format_epoch_seconds() {
    local epoch_seconds="$1"
    date -r "$epoch_seconds" 2>/dev/null || date -d "@$epoch_seconds"
}

claude_code_expires_at() {
    if [ -f "$CLAUDE_CREDS" ]; then
        claude_creds_value "claudeAiOauth.expiresAt" "0"
        return
    fi
    if [ "$USE_JSON" -eq 1 ]; then
        json_expires_for_claude_cli
        return
    fi
    echo "0"
}

claude_code_refresh_present() {
    if [ ! -f "$CLAUDE_CREDS" ]; then
        return 1
    fi
    local has_refresh
    has_refresh=$(claude_creds_value "claudeAiOauth.refreshToken" "")
    [ -n "$has_refresh" ]
}

calc_claude_code_status() {
    local expires_at="$1"
    local status
    local rc=0
    status=$(calc_status_from_expires "$expires_at") || rc=$?
    if [ "$rc" -ne 0 ] && claude_code_refresh_present; then
        echo "OK:refreshable"
        return 0
    fi
    echo "$status"
    return "$rc"
}

json_expires_for_claude_cli() {
    status_json_value "claude_expires"
}

json_expires_for_anthropic_any() {
    status_json_value "anthropic_any_expires"
}

json_best_anthropic_profile() {
    status_json_value "best_profile"
}

json_anthropic_api_key_count() {
    status_json_value "api_key_count"
}

check_claude_code_auth() {
    if [ ! -f "$CLAUDE_CREDS" ]; then
        if [ "$USE_JSON" -eq 1 ]; then
            local json_expires_at
            json_expires_at=$(json_expires_for_claude_cli)
            calc_status_from_expires "$json_expires_at"
            return $?
        fi
        echo "MISSING"
        return 1
    fi

    local expires_at
    expires_at=$(claude_code_expires_at)
    calc_claude_code_status "$expires_at"
}

check_openclaw_auth() {
    if [ "$USE_JSON" -eq 1 ]; then
        local api_keys
        api_keys=$(json_anthropic_api_key_count)
        if ! [[ "$api_keys" =~ ^[0-9]+$ ]]; then
            api_keys=0
        fi
        local oauth_count
        oauth_count=$(status_json_value "anthropic_oauth_count")
        if ! [[ "$oauth_count" =~ ^[0-9]+$ ]]; then
            oauth_count=0
        fi
        local expires_at
        expires_at=$(json_expires_for_anthropic_any)

        if [ "$expires_at" -le 0 ] && [ "$api_keys" -eq 0 ] && [ "$oauth_count" -eq 0 ]; then
            echo "SKIPPED:no-anthropic"
            return 0
        fi

        if [ "$expires_at" -le 0 ] && [ "$api_keys" -gt 0 ]; then
            echo "OK:static"
            return 0
        fi

        calc_status_from_expires "$expires_at"
        return $?
    fi

    if [ ! -f "$OPENCLAW_AUTH" ]; then
        echo "MISSING"
        return 1
    fi

    local anthropic_count
    anthropic_count=$(openclaw_auth_value "anthropic_count")
    if ! [[ "$anthropic_count" =~ ^[0-9]+$ ]]; then
        anthropic_count=0
    fi
    if [ "$anthropic_count" -eq 0 ]; then
        echo "SKIPPED:no-anthropic"
        return 0
    fi

    local expires
    expires=$(openclaw_auth_value "max_expires")

    calc_status_from_expires "$expires"
}

# JSON output mode
if [ "$OUTPUT_MODE" = "json" ]; then
    claude_status=$(check_claude_code_auth 2>/dev/null || true)
    openclaw_status=$(check_openclaw_auth 2>/dev/null || true)

    claude_expires=0
    openclaw_expires=0
    if [ "$USE_JSON" -eq 1 ]; then
        claude_expires=$(claude_code_expires_at)
        openclaw_expires=$(json_expires_for_anthropic_any)
    else
        claude_expires=$(claude_code_expires_at)
        openclaw_expires=$(openclaw_auth_value "default_expires")
    fi

    emit_status_json "$claude_status" "$claude_expires" "$openclaw_status" "$openclaw_expires"
    exit 0
fi

# Simple output mode (for scripts/widgets)
if [ "$OUTPUT_MODE" = "simple" ]; then
    claude_status=$(check_claude_code_auth 2>/dev/null || true)
    openclaw_status=$(check_openclaw_auth 2>/dev/null || true)

    if [[ "$claude_status" == EXPIRED* ]] || [[ "$claude_status" == MISSING* ]]; then
        echo "CLAUDE_EXPIRED"
        exit 1
    elif [[ "$openclaw_status" == EXPIRED* ]] || [[ "$openclaw_status" == MISSING* ]]; then
        echo "OPENCLAW_EXPIRED"
        exit 1
    elif [[ "$claude_status" == EXPIRING* ]]; then
        echo "CLAUDE_EXPIRING"
        exit 2
    elif [[ "$openclaw_status" == EXPIRING* ]]; then
        echo "OPENCLAW_EXPIRING"
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
echo "Claude Code ($CLAUDE_CREDS):"
expires_at=$(claude_code_expires_at)
has_refresh=0
if claude_code_refresh_present; then
    has_refresh=1
fi

if [ -f "$CLAUDE_CREDS" ]; then
    sub_type=$(claude_creds_value "claudeAiOauth.subscriptionType" "unknown")
    rate_tier=$(claude_creds_value "claudeAiOauth.rateLimitTier" "unknown")
    echo "  Subscription: $sub_type"
    echo "  Rate tier: $rate_tier"
fi

if [ "$expires_at" -le 0 ] && [ "$has_refresh" -eq 1 ]; then
    echo -e "  Status: ${GREEN}OK${NC} (refreshable)"
    echo "  Note: Access-token expiry is missing, but a refresh token is present."
elif [ "$expires_at" -le 0 ]; then
    echo -e "  Status: ${RED}NOT FOUND${NC}"
    echo "  Action needed: Run 'claude setup-token'"
else
    now_ms=$(( $(date +%s) * 1000 ))
    diff_ms=$((expires_at - now_ms))
    hours=$((diff_ms / 3600000))
    mins=$(((diff_ms % 3600000) / 60000))

    if [ "$diff_ms" -lt 0 ] && [ "$has_refresh" -eq 1 ]; then
        echo -e "  Status: ${GREEN}OK${NC} (refreshable)"
        echo "  Note: Access token expired; refresh token is present and Claude should refresh it on next run."
    elif [ "$diff_ms" -lt 0 ]; then
        echo -e "  Status: ${RED}EXPIRED${NC}"
        echo "  Action needed: Run 'claude setup-token' or re-authenticate"
    elif [ "$diff_ms" -lt 3600000 ] && [ "$has_refresh" -eq 1 ]; then
        echo -e "  Status: ${GREEN}OK${NC} (refreshable)"
        echo "  Access token expires in ${mins}m; refresh token is present."
    elif [ "$diff_ms" -lt 3600000 ]; then
        echo -e "  Status: ${YELLOW}EXPIRING SOON (${mins}m remaining)${NC}"
        echo "  Consider running: claude setup-token"
    else
        echo -e "  Status: ${GREEN}OK${NC}"
        echo "  Expires: $(format_epoch_seconds "$((expires_at/1000))") (${hours}h ${mins}m)"
    fi
fi

echo ""
echo "OpenClaw Auth (~/.openclaw/agents/main/agent/auth-profiles.json):"
openclaw_status_display=$(check_openclaw_auth 2>/dev/null || true)
if [ "$USE_JSON" -eq 1 ]; then
    best_profile=$(json_best_anthropic_profile)
    expires=$(json_expires_for_anthropic_any)
    api_keys=$(json_anthropic_api_key_count)
else
    best_profile=$(openclaw_auth_value "best_profile")
    expires=$(openclaw_auth_value "max_expires")
    api_keys=0
fi

echo "  Profile: $best_profile"

if [[ "$openclaw_status_display" == SKIPPED* ]]; then
    echo -e "  Status: ${GREEN}SKIPPED${NC} (no Anthropic OpenClaw profile configured)"
elif [ "$expires" -le 0 ] && [ "$api_keys" -gt 0 ]; then
    echo -e "  Status: ${GREEN}OK${NC} (API key)"
elif [ "$expires" -le 0 ]; then
    echo -e "  Status: ${RED}NOT FOUND${NC}"
    echo "  Note: Run 'openclaw doctor --yes' to sync from Claude Code"
else
    now_ms=$(( $(date +%s) * 1000 ))
    diff_ms=$((expires - now_ms))
    hours=$((diff_ms / 3600000))
    mins=$(((diff_ms % 3600000) / 60000))

    if [ "$diff_ms" -lt 0 ]; then
        echo -e "  Status: ${RED}EXPIRED${NC}"
        echo "  Note: Run 'openclaw doctor --yes' to sync from Claude Code"
    elif [ "$diff_ms" -lt 3600000 ]; then
        echo -e "  Status: ${YELLOW}EXPIRING SOON (${mins}m remaining)${NC}"
    else
        echo -e "  Status: ${GREEN}OK${NC}"
        echo "  Expires: $(format_epoch_seconds "$((expires/1000))") (${hours}h ${mins}m)"
    fi
fi

echo ""
echo "=== Service Status ==="
if systemctl --user is-active openclaw >/dev/null 2>&1; then
    echo -e "OpenClaw service: ${GREEN}running${NC}"
else
    echo -e "OpenClaw service: ${RED}NOT running${NC}"
fi
