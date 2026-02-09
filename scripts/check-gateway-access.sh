#!/bin/bash
# Quick script to check gateway access on fly.io

APP_NAME="${1:-openclaw-lisan-al-gaib}"

echo "Checking gateway status for app: $APP_NAME"
echo ""

echo "1. Checking if gateway is running..."
fly logs --no-tail -a "$APP_NAME" | grep -i "gateway\|listening" | tail -5
echo ""

echo "2. Testing health endpoint (via proxy)..."
echo "   Starting proxy in background..."
fly proxy 3000:3000 -a "$APP_NAME" > /dev/null 2>&1 &
PROXY_PID=$!
sleep 3

if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "   ✓ Gateway is accessible at http://localhost:3000"
    echo "   ✓ Control UI: http://localhost:3000/"
    echo "   ✓ Health endpoint: http://localhost:3000/health"
else
    echo "   ✗ Gateway not accessible (may need authentication or gateway not started)"
fi

kill $PROXY_PID 2>/dev/null
echo ""

echo "3. To access the gateway:"
echo "   - Start proxy: fly proxy 3000:3000 -a $APP_NAME"
echo "   - Open browser: http://localhost:3000/"
echo "   - Or use Tailscale if configured"
