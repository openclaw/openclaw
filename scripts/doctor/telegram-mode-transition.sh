#!/bin/bash
# Telegram mode transition helper
# Safely transitions between webhook and polling modes

set -e

echo "🔄 Telegram Mode Transition Helper"
echo "==================================="
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
    echo "   Set with: openclaw config set channels.telegram.botToken \"YOUR_TOKEN\""
    exit 1
fi

echo "🤖 Bot Token: ${BOT_TOKEN:0:20}..."
echo ""

# Detect current webhook status
echo "🔍 Checking current Telegram webhook status..."
WEBHOOK_INFO=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo")

WEBHOOK_URL=$(echo "$WEBHOOK_INFO" | grep -o '"url":"[^"]*"' | cut -d'"' -f4 || echo "")
PENDING_UPDATES=$(echo "$WEBHOOK_INFO" | grep -o '"pending_update_count":[0-9]*' | cut -d':' -f2 || echo "0")

if [ -n "$WEBHOOK_URL" ]; then
    echo "📍 Current mode: WEBHOOK"
    echo "   Webhook URL: $WEBHOOK_URL"
    echo "   Pending updates: $PENDING_UPDATES"
else
    echo "📍 Current mode: POLLING (or webhook not set)"
fi

echo ""

# Get target configuration
CONFIG_WEBHOOK_URL=$(openclaw config get channels.telegram.webhookUrl 2>/dev/null | tr -d '"' || echo "")

if [ -n "$CONFIG_WEBHOOK_URL" ] && [ "$CONFIG_WEBHOOK_URL" != "null" ]; then
    TARGET_MODE="webhook"
else
    TARGET_MODE="polling"
fi

echo "🎯 Target mode from config: $TARGET_MODE"
echo ""

# Determine action needed
if [ -n "$WEBHOOK_URL" ] && [ "$TARGET_MODE" = "polling" ]; then
    echo "⚠️  TRANSITION NEEDED: Webhook → Polling"
    echo ""
    echo "   This requires:"
    echo "   1. Delete webhook from Telegram"
    echo "   2. Clear offset file to reset state"
    echo "   3. Restart gateway"
    echo ""
    read -p "   Proceed with transition? [y/N] " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Cancelled"
        exit 0
    fi

    echo ""
    echo "🔧 Step 1: Deleting webhook..."
    DELETE_RESULT=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook")

    if echo "$DELETE_RESULT" | grep -q '"ok":true'; then
        echo "✅ Webhook deleted"
    else
        echo "❌ Failed to delete webhook"
        echo "   Response: $DELETE_RESULT"
        exit 1
    fi

    echo ""
    echo "🔧 Step 2: Clearing offset files..."
    OPENCLAW_DIR="${HOME}/.openclaw"
    TELEGRAM_DIR="${OPENCLAW_DIR}/telegram"

    if [ -d "$TELEGRAM_DIR" ]; then
        # Find and delete offset files
        OFFSET_FILES=$(find "$TELEGRAM_DIR" -name "update-offset-*.json" 2>/dev/null || echo "")

        if [ -n "$OFFSET_FILES" ]; then
            echo "   Found offset files:"
            echo "$OFFSET_FILES" | sed 's/^/     /'
            echo ""

            for file in $OFFSET_FILES; do
                echo "   Deleting: $file"
                rm -f "$file"
            done

            echo "✅ Offset files cleared"
        else
            echo "   No offset files found (clean state)"
        fi
    else
        echo "   Telegram directory doesn't exist yet (clean state)"
    fi

    echo ""
    echo "🔧 Step 3: Restarting gateway..."

    if systemctl --user is-active openclaw-gateway.service &> /dev/null; then
        systemctl --user restart openclaw-gateway.service
        echo "✅ Gateway restarted"

        # Wait a bit for startup
        sleep 2

        # Check status
        if systemctl --user is-active openclaw-gateway.service &> /dev/null; then
            echo "✅ Gateway is running"
        else
            echo "❌ Gateway failed to start"
            echo ""
            echo "   Check logs:"
            echo "     journalctl --user -u openclaw-gateway -n 50"
            exit 1
        fi
    else
        echo "⚠️  Gateway not running as service"
        echo "   Start manually: openclaw gateway start"
    fi

    echo ""
    echo "✅ Transition complete!"
    echo ""
    echo "🧪 Testing polling mode..."
    sleep 3

    # Verify webhook is still deleted
    WEBHOOK_CHECK=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo")
    WEBHOOK_URL_CHECK=$(echo "$WEBHOOK_CHECK" | grep -o '"url":"[^"]*"' | cut -d'"' -f4 || echo "")

    if [ -z "$WEBHOOK_URL_CHECK" ]; then
        echo "✅ Webhook confirmed deleted"
    else
        echo "⚠️  Webhook reappeared: $WEBHOOK_URL_CHECK"
        echo "   Check your config - webhookUrl might be set"
    fi

    echo ""
    echo "📝 Next steps:"
    echo "   1. Send a test message to your bot"
    echo "   2. Check logs for message processing:"
    echo "      journalctl --user -u openclaw-gateway -f | grep telegram"
    echo "   3. Verify bot responds"
    echo ""

elif [ -z "$WEBHOOK_URL" ] && [ "$TARGET_MODE" = "webhook" ]; then
    echo "⚠️  TRANSITION NEEDED: Polling → Webhook"
    echo ""
    echo "   This requires:"
    echo "   1. Configure webhook URL and secret"
    echo "   2. Set webhook via Telegram API"
    echo "   3. Restart gateway"
    echo ""
    echo "📚 See documentation:"
    echo "   https://core.telegram.org/bots/api#setwebhook"
    echo ""
    echo "💡 This script currently handles webhook → polling only."
    echo "   For polling → webhook, follow the documentation."
    echo ""

else
    echo "✅ No transition needed"
    echo "   Current mode matches configuration"
    echo ""

    # Still check for stale offset files if on polling
    if [ "$TARGET_MODE" = "polling" ]; then
        echo "🧹 Checking for stale offset files..."
        TELEGRAM_DIR="${HOME}/.openclaw/telegram"

        if [ -d "$TELEGRAM_DIR" ]; then
            OFFSET_FILES=$(find "$TELEGRAM_DIR" -name "update-offset-*.json" -mtime +7 2>/dev/null || echo "")

            if [ -n "$OFFSET_FILES" ]; then
                FILE_COUNT=$(echo "$OFFSET_FILES" | wc -l)
                echo "⚠️  Found $FILE_COUNT offset file(s) older than 7 days"
                echo ""
                echo "   If experiencing issues, consider clearing them:"
                echo "     ./scripts/troubleshooting/fix-telegram-polling.sh"
                echo ""
            else
                echo "✅ No stale offset files"
            fi
        fi
    fi
fi

echo ""
echo "📊 Current Status"
echo "================="
echo ""
echo "   Mode: $TARGET_MODE"

if systemctl --user is-active openclaw-gateway.service &> /dev/null; then
    echo "   Gateway: ✅ Running"
else
    echo "   Gateway: ❌ Not running"
fi

echo ""
echo "💡 For ongoing issues, see:"
echo "   - ./scripts/troubleshooting/fix-telegram-polling.sh"
echo "   - GitHub Issue #20519"
echo ""
