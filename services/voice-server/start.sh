#!/bin/bash
# Clawd Voice Server v4.0 — OpenClaw Gateway + OpenAI STT/TTS
# Usage: ./start.sh

set -e
cd "$(dirname "$0")"

PORT=${PORT:-8765}

echo "🎙️  Starting Clawd Voice Server v4.0..."
echo ""

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
  echo ""
fi

# Check if ngrok is available
if ! command -v ngrok &> /dev/null; then
  echo "❌ ngrok not found. Install from https://ngrok.com/download"
  echo "   brew install ngrok/ngrok/ngrok"
  exit 1
fi

# The server reads its own token from ~/.openclaw/openclaw.json
# and connects directly to the local OpenClaw gateway.
echo "🚀 Starting voice server on port $PORT..."
node server.js
