#!/bin/bash

echo "🔧 Direct Terminal Deployment to ClawCloud"
echo "======================================"

APP_URL="http://openclaw-hlpomtim.ap-southeast-1.clawcloud.run"

echo "📡 Connecting to app terminal..."

# Try to access terminal/CLI endpoints
echo "🔍 Testing terminal access..."
TERMINAL_TEST=$(curl -s "$APP_URL/terminal" -H "Accept: text/plain" 2>/dev/null || echo "no-terminal")

if [[ "$TERMINAL_TEST" == "no-terminal" ]]; then
    echo "⚠️  Direct terminal access not available"
    echo ""
    echo "🎯 Alternative methods:"
    echo "1. Use web interface: $APP_URL"
    echo "2. Update git repo to your fork"
    echo "3. Use API endpoints for configuration"
    echo ""
    echo "📱 Use Telegram commands instead:"
    echo "  /onboard"
    echo "  /status" 
    echo "  /models"
else
    echo "✅ Terminal access available"
    echo "$TERMINAL_TEST"
fi
