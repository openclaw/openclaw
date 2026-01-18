#!/bin/sh
# Script to enable Zalo plugin after gateway starts
# This script should be run after the gateway container starts

set -e

CLAWDBOT_DIR="/home/node/.clawdbot"
PLUGINS_FILE="$CLAWDBOT_DIR/plugins.json"

echo "=== Zalo Plugin Auto-Enable Script ==="

# Wait for gateway to be ready
echo "Waiting for gateway to start..."
sleep 10

# Create plugins.json to enable Zalo
echo "Creating plugins.json with Zalo enabled..."
cat > "$PLUGINS_FILE" << 'EOF'
{
  "enabled": {
    "zalo": true
  }
}
EOF

echo "✅ plugins.json created at $PLUGINS_FILE"
cat "$PLUGINS_FILE"

echo ""
echo "=== Plugin Configuration Complete ==="
echo "Note: Gateway needs to be restarted to load the plugin."
echo "Run: kill 1 (inside container) or kubectl exec ... -- kill 1"
