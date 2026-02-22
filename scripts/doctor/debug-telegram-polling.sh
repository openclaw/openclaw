#!/bin/bash
# Telegram polling diagnostic tool
# Helps diagnose why messages are being dropped

set -e

echo "🔍 Telegram Polling Diagnostics"
echo "================================"
echo ""

# Check if openclaw is installed
if ! command -v openclaw &> /dev/null; then
    echo "❌ openclaw command not found"
    exit 1
fi

# Get bot token
BOT_TOKEN=$(openclaw config get channels.telegram.botToken 2>/dev/null | tr -d '"' || echo "")

if [ -z "$BOT_TOKEN" ] || [ "$BOT_TOKEN" = "null" ]; then
    echo "❌ Telegram bot token not configured"
    exit 1
fi

echo "🤖 Bot Token: ${BOT_TOKEN:0:20}..."
echo ""

# Check 1: Gateway Status
echo "1️⃣  Gateway Status"
echo "-----------------"
echo ""

if systemctl --user is-active openclaw-gateway.service &> /dev/null; then
    UPTIME=$(systemctl --user show openclaw-gateway.service --property=ActiveEnterTimestamp | cut -d'=' -f2)
    echo "✅ Gateway running since: $UPTIME"
else
    echo "❌ Gateway not running"
    echo "   Start with: systemctl --user start openclaw-gateway.service"
    exit 1
fi

echo ""

# Check 2: Channel Status
echo "2️⃣  Telegram Channel Status"
echo "-------------------------"
echo ""

CHANNEL_STATUS=$(openclaw channels status 2>/dev/null | grep -i telegram || echo "")

if [ -n "$CHANNEL_STATUS" ]; then
    echo "$CHANNEL_STATUS"
else
    echo "⚠️  No Telegram channel status available"
fi

echo ""

# Check 3: Bot API Status
echo "3️⃣  Telegram Bot API"
echo "-------------------"
echo ""

# Get bot info
BOT_INFO=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getMe")

if echo "$BOT_INFO" | grep -q '"ok":true'; then
    BOT_USERNAME=$(echo "$BOT_INFO" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)
    BOT_NAME=$(echo "$BOT_INFO" | grep -o '"first_name":"[^"]*"' | cut -d'"' -f4)
    echo "✅ Bot connected: @$BOT_USERNAME ($BOT_NAME)"
else
    echo "❌ Bot API error"
    echo "   Response: $BOT_INFO"
    exit 1
fi

echo ""

# Check 4: Pending Updates
echo "4️⃣  Pending Updates"
echo "------------------"
echo ""

PENDING_UPDATES=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1&limit=1")

if echo "$PENDING_UPDATES" | grep -q '"ok":true'; then
    RESULT=$(echo "$PENDING_UPDATES" | grep -o '"result":\[.*\]' || echo '"result":[]')

    if [ "$RESULT" = '"result":[]' ]; then
        echo "✅ No pending updates (all consumed)"
        echo "   This is normal if messages were already processed"
    else
        echo "⚠️  Pending updates exist"
        echo "   Last update:"
        echo "$RESULT" | sed 's/^/   /'
        echo ""
        echo "   This means messages were fetched but not processed!"
    fi
else
    echo "❌ Failed to check updates"
    echo "   Response: $PENDING_UPDATES"
fi

echo ""

# Check 5: Webhook Status
echo "5️⃣  Webhook Status"
echo "-----------------"
echo ""

WEBHOOK_INFO=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo")
WEBHOOK_URL=$(echo "$WEBHOOK_INFO" | grep -o '"url":"[^"]*"' | cut -d'"' -f4 || echo "")

if [ -n "$WEBHOOK_URL" ]; then
    echo "⚠️  WEBHOOK ACTIVE: $WEBHOOK_URL"
    echo ""
    echo "   This blocks polling mode!"
    echo ""
    echo "   💡 Fix:"
    echo "      ./scripts/doctor/telegram-mode-transition.sh"
    echo ""
else
    echo "✅ No webhook configured (polling mode OK)"
fi

echo ""

# Check 6: Access Control Config
echo "6️⃣  Access Control Configuration"
echo "--------------------------------"
echo ""

DM_POLICY=$(openclaw config get channels.telegram.dmPolicy 2>/dev/null | tr -d '"' || echo "")
ALLOW_FROM=$(openclaw config get channels.telegram.allowFrom 2>/dev/null || echo "")

echo "   dmPolicy: $DM_POLICY"
echo "   allowFrom: $ALLOW_FROM"
echo ""

if [ "$DM_POLICY" = "open" ]; then
    if [[ "$ALLOW_FROM" =~ \* ]]; then
        echo "✅ Access control configured for open bot"
    else
        echo "❌ CONFIG MISMATCH!"
        echo "   dmPolicy is 'open' but allowFrom doesn't include '*'"
        echo ""
        echo "   💡 Fix:"
        echo "      openclaw config set channels.telegram.allowFrom '[\"*\"]'"
        echo ""
    fi
elif [ "$DM_POLICY" = "pairing" ]; then
    echo "✅ Pairing mode (users must pair first)"
else
    echo "⚠️  dmPolicy: $DM_POLICY (uncommon value)"
fi

echo ""

# Check 7: Recent Logs
echo "7️⃣  Recent Telegram Logs (Last 10 minutes)"
echo "------------------------------------------"
echo ""

if command -v journalctl &> /dev/null; then
    RECENT_LOGS=$(journalctl --user -u openclaw-gateway --since "10 minutes ago" 2>/dev/null \
        | grep -i telegram \
        | grep -v "heartbeat" \
        | tail -20 || echo "")

    if [ -n "$RECENT_LOGS" ]; then
        echo "$RECENT_LOGS" | sed 's/^/   /'
    else
        echo "   No Telegram-related logs in last 10 minutes"
        echo "   (This might indicate polling isn't active)"
    fi
else
    echo "   journalctl not available"
fi

echo ""

# Check 8: Agent Invocations
echo "8️⃣  Agent Invocations (Last 10 minutes)"
echo "---------------------------------------"
echo ""

if command -v journalctl &> /dev/null; then
    AGENT_LOGS=$(journalctl --user -u openclaw-gateway --since "10 minutes ago" 2>/dev/null \
        | grep "messageChannel=telegram" \
        | tail -10 || echo "")

    if [ -n "$AGENT_LOGS" ]; then
        echo "✅ Found agent invocations with messageChannel=telegram:"
        echo ""
        echo "$AGENT_LOGS" | sed 's/^/   /'
    else
        echo "❌ NO AGENT INVOCATIONS FOUND!"
        echo ""
        echo "   This is the bug - messages are received but not processed"
        echo ""
        echo "   Comparison check - webchat invocations:"
        WEBCHAT_LOGS=$(journalctl --user -u openclaw-gateway --since "10 minutes ago" 2>/dev/null \
            | grep "messageChannel=webchat" \
            | tail -3 || echo "")

        if [ -n "$WEBCHAT_LOGS" ]; then
            echo "   ✅ Webchat works (proves agent system is functional)"
        else
            echo "   ⚠️  No webchat invocations either"
        fi
    fi
else
    echo "   journalctl not available"
fi

echo ""

# Check 9: Offset File
echo "9️⃣  Offset File Status"
echo "---------------------"
echo ""

OPENCLAW_DIR="${HOME}/.openclaw"
TELEGRAM_DIR="${OPENCLAW_DIR}/telegram"
OFFSET_FILE="${TELEGRAM_DIR}/update-offset-default.json"

if [ -f "$OFFSET_FILE" ]; then
    OFFSET_VALUE=$(cat "$OFFSET_FILE" 2>/dev/null || echo "")
    FILE_AGE=$(stat -c %Y "$OFFSET_FILE" 2>/dev/null || stat -f %m "$OFFSET_FILE" 2>/dev/null || echo "0")
    NOW=$(date +%s)
    AGE_SECONDS=$((NOW - FILE_AGE))
    AGE_MINUTES=$((AGE_SECONDS / 60))

    echo "✅ Offset file exists"
    echo "   Path: $OFFSET_FILE"
    echo "   Content: $OFFSET_VALUE"
    echo "   Last modified: ${AGE_MINUTES} minutes ago"
    echo ""

    if [ $AGE_MINUTES -gt 60 ]; then
        echo "⚠️  Offset file is stale (>60 minutes old)"
        echo "   This might indicate polling isn't active"
    fi
else
    echo "⚠️  No offset file found"
    echo "   Path: $OFFSET_FILE"
    echo "   This might be a fresh setup"
fi

echo ""
echo ""

# Summary
echo "📊 Diagnostic Summary"
echo "====================="
echo ""

# Determine likely issue
if [ -n "$WEBHOOK_URL" ]; then
    echo "🔴 ISSUE: Webhook is active (blocks polling)"
    echo ""
    echo "   Run: ./scripts/doctor/telegram-mode-transition.sh"
    echo ""
elif [ "$DM_POLICY" = "open" ] && [[ ! "$ALLOW_FROM" =~ \* ]]; then
    echo "🔴 ISSUE: Access control misconfiguration"
    echo ""
    echo "   Run: openclaw config set channels.telegram.allowFrom '[\"*\"]'"
    echo ""
elif [ -z "$AGENT_LOGS" ]; then
    echo "🔴 ISSUE: Messages not reaching agent (Bug #20518)"
    echo ""
    echo "   This is the critical Telegram polling bug."
    echo ""
    echo "   Workaround:"
    echo "     ./scripts/troubleshooting/fix-telegram-polling.sh"
    echo ""
    echo "   See analysis:"
    echo "     cat TELEGRAM_POLLING_BUG_ANALYSIS.md"
    echo ""
else
    echo "✅ System appears healthy"
    echo ""
    echo "   If still experiencing issues:"
    echo "   1. Send a test message to the bot"
    echo "   2. Run this script again"
    echo "   3. Check logs: journalctl --user -u openclaw-gateway -f"
    echo ""
fi

echo "📚 Additional Resources:"
echo "   - GitHub Issue: https://github.com/openclaw/openclaw/issues/20518"
echo "   - Bug Analysis: ./TELEGRAM_POLLING_BUG_ANALYSIS.md"
echo "   - Quick Fix: ./scripts/troubleshooting/fix-telegram-polling.sh"
echo ""
