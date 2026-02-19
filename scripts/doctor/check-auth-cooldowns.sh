#!/bin/bash
# Diagnostic tool for stuck authentication cooldowns
# Addresses #3604: Cooldown stuck forever on auth failures

set -e

echo "🔐 OpenClaw Authentication Cooldown Checker"
echo "==========================================="
echo ""

STATE_DIR="${HOME}/.openclaw/agents/default/state"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

if [ ! -d "$STATE_DIR" ]; then
    echo "❌ State directory not found: $STATE_DIR"
    echo "   Check your agent ID and workspace location"
    exit 1
fi

echo "📂 Scanning: $STATE_DIR"
echo ""

# Function to get cooldown state from files
check_cooldown_state() {
    local state_file="$1"

    if [ ! -f "$state_file" ]; then
        echo "0"
        return
    fi

    # Extract cooldown expiry timestamp
    jq -r '.authCooldown.expiresAt // empty' "$state_file" 2>/dev/null || echo ""
}

# Function to check if cooldown is expired but not cleared
is_cooldown_stuck() {
    local expires_at="$1"
    local current_time=$(date -u +%s)

    if [ -z "$expires_at" ]; then
        echo "no"
        return
    fi

    # Convert ISO timestamp to epoch
    local expires_epoch=$(date -d "$expires_at" +%s 2>/dev/null || echo "0")

    if [ "$expires_epoch" -gt 0 ] && [ "$current_time" -gt "$expires_epoch" ]; then
        echo "yes"
    else
        echo "no"
    fi
}

# Get cooldown config
COOLDOWN_DURATION=$(jq -r '.models.auth.cooldown.duration // "600000"' "$CONFIG_FILE" 2>/dev/null)
COOLDOWN_DURATION_SEC=$((COOLDOWN_DURATION / 1000))

echo "⚙️  Configuration"
echo "================"
echo "Cooldown duration: ${COOLDOWN_DURATION_SEC}s (${COOLDOWN_DURATION}ms)"
echo ""

STUCK_COOLDOWNS=()
ACTIVE_COOLDOWNS=()
TOTAL_CHECKED=0

echo "🔍 Checking cooldown state files..."
echo ""

# Check auth state files
for state_file in "$STATE_DIR"/auth-*.json; do
    if [ ! -f "$state_file" ]; then
        continue
    fi

    TOTAL_CHECKED=$((TOTAL_CHECKED + 1))

    PROVIDER=$(basename "$state_file" | sed 's/auth-\(.*\)\.json/\1/')
    EXPIRES_AT=$(check_cooldown_state "$state_file")

    if [ -z "$EXPIRES_AT" ]; then
        continue
    fi

    IS_STUCK=$(is_cooldown_stuck "$EXPIRES_AT")
    CURRENT_TIME=$(date -u +%s)
    EXPIRES_EPOCH=$(date -d "$EXPIRES_AT" +%s 2>/dev/null || echo "0")
    TIME_DIFF=$((CURRENT_TIME - EXPIRES_EPOCH))

    if [ "$IS_STUCK" = "yes" ]; then
        STUCK_COOLDOWNS+=("$PROVIDER|$EXPIRES_AT|$TIME_DIFF")

        echo "⚠️  Stuck cooldown: $PROVIDER"
        echo "   Expired at: $EXPIRES_AT"
        echo "   Time stuck: ${TIME_DIFF}s ($(($TIME_DIFF / 60)) minutes)"

        # Check for repeated failures
        FAILURE_COUNT=$(jq -r '.authCooldown.failureCount // 0' "$state_file" 2>/dev/null)
        if [ "$FAILURE_COUNT" -gt 0 ]; then
            echo "   Failure count: $FAILURE_COUNT"
        fi

        # Check last error
        LAST_ERROR=$(jq -r '.authCooldown.lastError // empty' "$state_file" 2>/dev/null)
        if [ -n "$LAST_ERROR" ]; then
            echo "   Last error: $LAST_ERROR"
        fi

        echo ""
    elif [ "$EXPIRES_EPOCH" -gt "$CURRENT_TIME" ]; then
        ACTIVE_COOLDOWNS+=("$PROVIDER|$EXPIRES_AT")
        TIME_REMAINING=$((EXPIRES_EPOCH - CURRENT_TIME))

        echo "🕒 Active cooldown: $PROVIDER"
        echo "   Expires at: $EXPIRES_AT"
        echo "   Time remaining: ${TIME_REMAINING}s ($(($TIME_REMAINING / 60)) minutes)"
        echo ""
    fi
done

# Check registry state (alternative location)
REGISTRY_FILE="$STATE_DIR/registry.json"
if [ -f "$REGISTRY_FILE" ]; then
    REGISTRY_COOLDOWNS=$(jq -r '.authCooldowns // {} | to_entries[] | "\(.key)|\(.value.expiresAt)|\(.value.failureCount)"' "$REGISTRY_FILE" 2>/dev/null || echo "")

    if [ -n "$REGISTRY_COOLDOWNS" ]; then
        echo "🔍 Checking registry cooldown entries..."
        echo ""

        while IFS='|' read -r provider expires_at failure_count; do
            TOTAL_CHECKED=$((TOTAL_CHECKED + 1))
            IS_STUCK=$(is_cooldown_stuck "$expires_at")
            CURRENT_TIME=$(date -u +%s)
            EXPIRES_EPOCH=$(date -d "$expires_at" +%s 2>/dev/null || echo "0")
            TIME_DIFF=$((CURRENT_TIME - EXPIRES_EPOCH))

            if [ "$IS_STUCK" = "yes" ]; then
                STUCK_COOLDOWNS+=("$provider|$expires_at|$TIME_DIFF")

                echo "⚠️  Stuck cooldown (registry): $provider"
                echo "   Expired at: $expires_at"
                echo "   Time stuck: ${TIME_DIFF}s ($(($TIME_DIFF / 60)) minutes)"
                echo "   Failure count: $failure_count"
                echo ""
            fi
        done <<< "$REGISTRY_COOLDOWNS"
    fi
fi

echo "📊 Summary"
echo "=========="
echo "Total cooldowns checked: $TOTAL_CHECKED"
echo "Active cooldowns: ${#ACTIVE_COOLDOWNS[@]}"
echo "Stuck cooldowns: ${#STUCK_COOLDOWNS[@]}"
echo ""

if [ "${#STUCK_COOLDOWNS[@]}" -eq 0 ]; then
    if [ "${#ACTIVE_COOLDOWNS[@]}" -gt 0 ]; then
        echo "✅ No stuck cooldowns found"
        echo ""
        echo "Active cooldowns will expire automatically."
        echo "If authentication keeps failing, check credentials with:"
        echo "  openclaw models auth list"
    else
        echo "✅ No cooldowns active or stuck"
        echo ""
        echo "💡 Tip: Cooldowns activate after repeated auth failures"
        echo "   to prevent API rate limiting. This is normal behavior."
    fi
    echo ""
    exit 0
fi

# Display remediation options
echo "⚠️  Stuck Cooldown Detection"
echo ""
echo "Cooldowns that have expired but not cleared can prevent"
echo "authentication indefinitely. This is issue #3604."
echo ""
echo "Root causes:"
echo "1. Gateway restart during cooldown period"
echo "2. System clock changes (NTP sync, timezone)"
echo "3. Race condition in cooldown cleanup logic"
echo "4. State file corruption"
echo ""
echo "Options:"
echo "  1) Clear stuck cooldowns (recommended)"
echo "  2) Reset all cooldown state"
echo "  3) Show detailed state (debugging)"
echo "  4) Cancel (no changes)"
echo ""

read -p "Choose option (1-4): " OPTION

case $OPTION in
    1)
        echo ""
        echo "🧹 Clearing stuck cooldowns..."
        echo ""

        for entry in "${STUCK_COOLDOWNS[@]}"; do
            PROVIDER=$(echo "$entry" | cut -d'|' -f1)
            STATE_FILE="$STATE_DIR/auth-$PROVIDER.json"

            if [ -f "$STATE_FILE" ]; then
                # Remove cooldown from state file
                TMP_FILE=$(mktemp)
                jq 'del(.authCooldown)' "$STATE_FILE" > "$TMP_FILE"
                mv "$TMP_FILE" "$STATE_FILE"
                echo "✅ Cleared: $PROVIDER (auth-$PROVIDER.json)"
            fi
        done

        # Clear registry cooldowns
        if [ -f "$REGISTRY_FILE" ]; then
            TMP_FILE=$(mktemp)
            jq 'del(.authCooldowns)' "$REGISTRY_FILE" > "$TMP_FILE"
            mv "$TMP_FILE" "$REGISTRY_FILE"
            echo "✅ Cleared: Registry cooldowns"
        fi

        echo ""
        echo "✅ Stuck cooldowns cleared!"
        echo ""
        echo "Restart gateway to apply:"
        echo "  systemctl --user restart openclaw-gateway.service"
        ;;

    2)
        echo ""
        echo "🔄 Resetting all cooldown state..."
        echo ""

        read -p "⚠️  This will clear ALL cooldowns (active and stuck). Continue? (yes/no): " CONFIRM

        if [ "$CONFIRM" = "yes" ]; then
            # Clear all auth state files
            for state_file in "$STATE_DIR"/auth-*.json; do
                if [ -f "$state_file" ]; then
                    PROVIDER=$(basename "$state_file" | sed 's/auth-\(.*\)\.json/\1/')
                    TMP_FILE=$(mktemp)
                    jq 'del(.authCooldown)' "$state_file" > "$TMP_FILE"
                    mv "$TMP_FILE" "$state_file"
                    echo "✅ Reset: $PROVIDER"
                fi
            done

            # Clear registry
            if [ -f "$REGISTRY_FILE" ]; then
                TMP_FILE=$(mktemp)
                jq 'del(.authCooldowns)' "$REGISTRY_FILE" > "$TMP_FILE"
                mv "$TMP_FILE" "$REGISTRY_FILE"
                echo "✅ Reset: Registry"
            fi

            echo ""
            echo "✅ All cooldowns reset"
            echo ""
            echo "Restart gateway to apply:"
            echo "  systemctl --user restart openclaw-gateway.service"
        else
            echo "Cancelled"
        fi
        ;;

    3)
        echo ""
        echo "🔍 Detailed State"
        echo "================="
        echo ""

        for entry in "${STUCK_COOLDOWNS[@]}"; do
            PROVIDER=$(echo "$entry" | cut -d'|' -f1)
            STATE_FILE="$STATE_DIR/auth-$PROVIDER.json"

            if [ -f "$STATE_FILE" ]; then
                echo "Provider: $PROVIDER"
                echo "State file: $STATE_FILE"
                echo ""
                echo "Auth cooldown state:"
                jq '.authCooldown' "$STATE_FILE" 2>/dev/null || echo "  (none)"
                echo ""
                echo "---"
                echo ""
            fi
        done

        if [ -f "$REGISTRY_FILE" ]; then
            echo "Registry cooldowns:"
            jq '.authCooldowns' "$REGISTRY_FILE" 2>/dev/null || echo "  (none)"
            echo ""
        fi
        ;;

    4)
        echo "Cancelled"
        exit 0
        ;;

    *)
        echo "Invalid option"
        exit 1
        ;;
esac

echo ""
echo "💡 Prevention Tips"
echo "=================="
echo ""
echo "1. Avoid restarting gateway during cooldown periods"
echo ""
echo "2. Keep system clock synchronized (NTP):"
echo "   sudo timedatectl set-ntp true"
echo ""
echo "3. Monitor auth failures:"
echo "   journalctl --user -u openclaw-gateway | grep -i \"auth.*fail\""
echo ""
echo "4. Check credentials regularly:"
echo "   openclaw models auth list"
echo ""
echo "5. Configure appropriate cooldown duration:"
echo '   {"models": {"auth": {"cooldown": {"duration": 300000}}}}'
echo "   (default: 600000ms = 10 minutes)"
echo ""
echo "Related: Issue #3604 - Cooldown stuck forever"
echo ""
