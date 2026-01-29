#!/bin/bash
# Start Clawd IDE

cd "$(dirname "$0")"

# Kill any existing instance
pkill -f "node server/index.js" 2>/dev/null

# Start server
echo "🐾 Starting Clawd IDE..."
node server/index.js &

# Wait for server to start
sleep 2

# Open in browser
open http://localhost:3333

echo "✅ Clawd IDE running at http://localhost:3333"
echo "   Press Ctrl+C to stop"

# Keep running
wait
