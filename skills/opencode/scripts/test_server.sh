#!/bin/bash
# Simple OpenCode server test script

echo "Testing OpenCode server connection..."

# Check if server is running
if curl -s http://localhost:4096/global/health > /dev/null 2>&1; then
    echo "✓ Server is running at http://localhost:4096"
    
    # Get health info
    HEALTH=$(curl -s http://localhost:4096/global/health)
    echo "Health response: $HEALTH"
    
    # List sessions
    echo ""
    echo "Current sessions:"
    curl -s http://localhost:4096/session | python3 -m json.tool 2>/dev/null || echo "Unable to parse JSON (install python3 or jq)"
    
else
    echo "✗ Server not running at http://localhost:4096"
    echo ""
    echo "To start server:"
    echo "  opencode serve --port 4096 --hostname 127.0.0.1"
    echo ""
    echo "Or in background:"
    echo "  opencode serve --port 4096 --hostname 127.0.0.1 > /tmp/opencode-server.log 2>&1 &"
fi

echo ""
echo "OpenCode installation:"
which opencode || echo "opencode not in PATH"
echo "Binary location: /home/john/.nvm/versions/node/v20.20.0/lib/node_modules/opencode-ai/bin/opencode"
echo "Version: $(/home/john/.nvm/versions/node/v20.20.0/lib/node_modules/opencode-ai/bin/opencode --version 2>/dev/null || echo "Unknown")"