#!/bin/bash
# Fix Telegram polling when bot stops responding to messages
# Issue: https://github.com/openclaw/openclaw/issues/20503

set -e

echo "🔧 Telegram Polling Fix Script"
echo "==============================="
echo ""

# Check if openclaw is installed
if ! command -v openclaw &> /dev/null; then
    echo "❌ Error: openclaw not found in PATH"
    exit 1
fi

# Get OpenClaw config directory
OPENCLAW_DIR="${HOME}/.openclaw"
TELEGRAM_OFFSET_FILE="${OPENCLAW_DIR}/telegram/update-offset-default.json"

echo "📋 Current status:"
openclaw channels status 2>&1 | grep -A1 "Telegram" || echo "Telegram not configured"
echo ""

# Check if offset file exists
if [ -f "$TELEGRAM_OFFSET_FILE" ]; then
    echo "📄 Found offset file: $TELEGRAM_OFFSET_FILE"
    echo "   Current offset: $(cat $TELEGRAM_OFFSET_FILE 2>/dev/null)"
else
    echo "ℹ️  No offset file found (this is OK)"
fi

echo ""
echo "🛠️  Applying fix..."
echo ""

# Stop gateway if running with systemd
if systemctl --user is-active openclaw-gateway.service &> /dev/null; then
    echo "⏸️  Stopping gateway (systemd)..."
    systemctl --user stop openclaw-gateway.service
    USING_SYSTEMD=true
elif pgrep -f "openclaw gateway" > /dev/null; then
    echo "⏸️  Gateway is running, please stop it manually"
    echo "   Run: openclaw gateway stop"
    exit 1
else
    echo "ℹ️  Gateway not running"
    USING_SYSTEMD=false
fi

# Delete offset file
if [ -f "$TELEGRAM_OFFSET_FILE" ]; then
    echo "🗑️  Deleting offset file..."
    rm -f "$TELEGRAM_OFFSET_FILE"
    echo "   ✅ Deleted"
else
    echo "   ℹ️  Offset file already removed"
fi

# Check webhook status and delete if active
echo ""
echo "🔍 Checking webhook status..."
BOT_TOKEN=$(openclaw config get channels.telegram.botToken 2>/dev/null | tr -d '"')
if [ -n "$BOT_TOKEN" ]; then
    WEBHOOK_INFO=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo")
    WEBHOOK_URL=$(echo "$WEBHOOK_INFO" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)

    if [ -n "$WEBHOOK_URL" ]; then
        echo "   ⚠️  Webhook is active: $WEBHOOK_URL"
        echo "   🗑️  Deleting webhook..."
        curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook" > /dev/null
        echo "   ✅ Webhook deleted"
    else
        echo "   ✅ No webhook configured (polling mode OK)"
    fi
else
    echo "   ⚠️  Could not get bot token from config"
fi

# Restart gateway
echo ""
if [ "$USING_SYSTEMD" = true ]; then
    echo "▶️  Starting gateway..."
    systemctl --user start openclaw-gateway.service
    sleep 2
    echo ""
    echo "📊 Status:"
    systemctl --user status openclaw-gateway.service --no-pager -l | head -10
else
    echo "ℹ️  Please start gateway manually:"
    echo "   Run: openclaw gateway start"
fi

echo ""
echo "✅ Fix applied!"
echo ""
echo "🧪 To test:"
echo "   1. Open Telegram"
echo "   2. Send a message to your bot"
echo "   3. Bot should respond within 5-10 seconds"
echo ""
echo "📝 If issue persists, see: https://github.com/openclaw/openclaw/issues/20503"
