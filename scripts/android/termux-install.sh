#!/bin/bash
#
# OpenClaw Termux Installation Script
# ======================================
# This script helps install OpenClaw Gateway on Android via Termux.
#
# IMPORTANT LIMITATIONS:
# - Running Gateway on Android is NOT recommended for production
# - Android has limited background execution and battery constraints
# - For production use, run Gateway on a remote Linux/Windows/macOS server
# - Android is better suited as a CLIENT/NODE, not as a Gateway host
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/android/termux-install.sh | bash
#

set -e

echo "=========================================="
echo "OpenClaw Termux Installation Script"
echo "=========================================="
echo ""
echo "⚠️  WARNING: Running Gateway on Android is NOT recommended for production!"
echo "   For production use, run Gateway on a remote Linux/Windows/macOS server."
echo "   Android should be used as a CLIENT/NODE, not as a Gateway host."
echo ""

# Check if running in Termux
if [ ! -f /proc/version ] && [ -z "$TERMUX_VERSION" ]; then
    echo "❌ This script must be run in Termux on Android."
    echo "   Download Termux from: https://f-droid.org/packages/com.termux/"
    exit 1
fi

echo "Step 1: Update package repository..."
pkg update

echo "Step 2: Install Node.js 22+..."
pkg install nodejs

# Verify Node.js version
NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "❌ Node.js 22+ required. Current version: $(node --version)"
    exit 1
fi
echo "✓ Node.js $(node --version) installed"

echo "Step 3: Install OpenClaw..."
npm install -g openclaw@latest

echo "Step 4: Verify installation..."
openclaw --version

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Configure OpenClaw: nano ~/.openclaw/openclaw.json"
echo "2. Start Gateway: openclaw gateway run --port 18789"
echo "3. For background running, see: https://docs.openclaw.ai/platforms/android-termux"
echo ""
echo "⚠️  Remember: For production, use a remote server for Gateway!"
echo ""
