#!/bin/bash
# Setup Ollama usage cookie for fetching usage limits from ollama.com/settings
#
# Usage:
#   ./scripts/setup-ollama-cookie.sh
#
# This script helps you set up the OLLAMA_COOKIE environment variable,
# which is used to fetch your Ollama usage limits (session/weekly percentages).

set -e

echo ""
echo "🦞 Ollama Usage Cookie Setup"
echo ""
echo "To fetch your Ollama usage limits (session/weekly), you need to provide"
echo "your browser session cookie from ollama.com."
echo ""

# Try to open browser
echo "Opening ollama.com in your browser..."
if command -v open &> /dev/null; then
    open "https://ollama.com/settings" 2>/dev/null || true
elif command -v xdg-open &> /dev/null; then
    xdg-open "https://ollama.com/settings" 2>/dev/null || true
else
    echo "Could not open browser. Please navigate to: https://ollama.com/settings"
fi

echo ""
echo "Instructions:"
echo "  1. Log into your Ollama account in the browser"
echo "  2. Open DevTools (F12 or right-click → Inspect)"
echo "  3. Go to Application → Cookies → ollama.com"
echo "  4. Find the session cookie (usually '__Secure-session' or 'session')"
echo "  5. Copy the cookie value"
echo ""

# Prompt for cookie
read -p "Paste the cookie value (or press Enter to skip): " COOKIE_VALUE

if [ -z "$COOKIE_VALUE" ]; then
    echo ""
    echo "Skipped. To set up manually, add to your shell config:"
    echo ""
    echo "  export OLLAMA_COOKIE='__Secure-session=YOUR_COOKIE_VALUE'"
    echo ""
    exit 0
fi

# Format cookie
COOKIE="$COOKIE_VALUE"
if [[ ! "$COOKIE_VALUE" =~ "=" ]]; then
    COOKIE="__Secure-session=$COOKIE_VALUE"
fi

echo ""
echo "Add this line to your ~/.zshrc or ~/.bashrc:"
echo ""
echo "  export OLLAMA_COOKIE='$COOKIE'"
echo ""

# Ask if user wants to add it now
read -p "Add to ~/.zshrc now? (y/N): " ADD_NOW

if [ "$ADD_NOW" = "y" ] || [ "$ADD_NOW" = "Y" ]; then
    echo "" >> ~/.zshrc
    echo "# Ollama usage cookie for fetching usage limits" >> ~/.zshrc
    echo "export OLLAMA_COOKIE='$COOKIE'" >> ~/.zshrc
    echo ""
    echo "✓ Added to ~/.zshrc"
    echo ""
    echo "Run 'source ~/.zshrc' or restart your terminal to apply."
    echo ""
    echo "Then restart OpenClaw gateway to pick up the new environment variable."
else
    echo ""
    echo "To apply manually, run:"
    echo ""
    echo "  export OLLAMA_COOKIE='$COOKIE'"
    echo ""
fi

echo "After setting the cookie, your /status command will show:"
echo "  📊 Usage: Session 97% left ⏱4h · Weekly 98% left ⏱6d"
echo ""