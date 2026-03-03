#!/bin/bash

echo "🔧 OpenClaw ECC Bot Fix Script"
echo "============================="

APP_URL="http://openclaw-hlpomtim.ap-southeast-1.clawcloud.run"

echo "📡 Testing app health..."
if curl -s "$APP_URL/health" | grep -q "OK"; then
    echo "✅ App is healthy"
else
    echo "❌ App health check failed"
    exit 1
fi

echo ""
echo "🤖 Testing Telegram bot connection..."
BOT_STATUS=$(curl -s "$APP_URL/api/channels/telegram/status" 2>/dev/null || echo "redirecting")

if [[ "$BOT_STATUS" == *"redirecting"* ]]; then
    echo "⚠️  API endpoints redirecting - need to restart services"
    echo ""
    echo "🔧 Steps to fix:"
    echo "1. Go to your ClawCloud app dashboard"
    echo "2. Click 'Restart' button"
    echo "3. Wait 2-3 minutes"
    echo "4. Test again"
    echo ""
    echo "📱 After restart, send /onboard to @picklerick777bot"
else
    echo "✅ Bot API accessible"
fi

echo ""
echo "🧪 Quick test commands for Telegram:"
echo "  /onboard     - Start ECC onboarding"
echo "  /status      - Check system status"
echo "  /help        - Show all commands"
echo ""
echo "🔍 If bot still doesn't respond after restart:"
echo "1. Check CLAWDBOT_TELEGRAM_USER_ID is set to 7848084308"
echo "2. Verify NVIDIA_API_KEY is correct"
echo "3. Check app logs for errors"
