#!/bin/bash
set -e

echo "🦞 ArmorIQ Demo Setup & Start Script"
echo "===================================="
echo

cd /Users/arunkumarv/Documents/Customer_ArmorIQ/aiq-openclaw

echo "✓ Checking OpenClaw Gateway..."
if lsof -i :18789 >/dev/null 2>&1; then
    echo "  Gateway is running on port 18789"
else
    echo "  ⚠️  Gateway not running. Start it with:"
    echo "     pnpm openclaw gateway run --bind loopback --port 18789 --force"
    exit 1
fi

echo
echo "✓ Checking CSRG IAP Service..."
if lsof -i :8000 >/dev/null 2>&1; then
    echo "  CSRG IAP is running on port 8000"
else
    echo "  ⚠️  CSRG IAP not running. Starting it..."
    echo
    cd /Users/arunkumarv/Documents/Customer_ArmorIQ/csrg-iap-customer
    uvicorn csrg_iap.main:app --host 0.0.0.0 --port 8000 --reload &
    CSRG_PID=$!
    echo "  Started CSRG IAP (PID: $CSRG_PID)"
    sleep 3
    cd /Users/arunkumarv/Documents/Customer_ArmorIQ/aiq-openclaw
fi

echo
echo "✓ Checking channels..."
pnpm openclaw channels status --probe 2>&1 | grep -E "Telegram|Slack" || {
    echo "  ⚠️  Channels not properly configured"
    exit 1
}

echo
echo "✓ Updating .env with gateway token..."
if ! grep -q "AIQ_DEMO_GATEWAY_TOKEN=armoriq-local-dev" aiqdemo/.env 2>/dev/null; then
    echo "AIQ_DEMO_GATEWAY_TOKEN=armoriq-local-dev" >> aiqdemo/.env
    echo "  Updated aiqdemo/.env"
else
    echo "  Already configured"
fi

echo
echo "✓ Verifying demo assets..."
if [ ! -f "aiqdemo/wallet.log" ]; then
    echo "  Generating demo assets..."
    pnpm aiq:demo setup
else
    echo "  Demo assets exist"
fi

echo
echo "===================================="
echo "✅ ArmorIQ Demo is Ready!"
echo "===================================="
echo
echo "📋 Demo Prompts:"
echo "   View all prompts:"
echo "   $ pnpm aiq:demo prompts"
echo
echo "💬 Send prompts to:"
echo "   - Telegram: @Armoriq_bot"
echo "   - Slack: Your configured bot"
echo
echo "🧪 Test intent drift:"
echo "   $ source aiqdemo/.env"
echo "   $ pnpm aiq:demo invoke --segment=5b"
echo
echo "📖 Full guide:"
echo "   $ cat aiqdemo/START-DEMO.md"
echo
