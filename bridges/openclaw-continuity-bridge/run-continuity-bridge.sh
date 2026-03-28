#!/bin/bash
set -euo pipefail

export HOME="/Users/clawdbot"
export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

export OPENCLAW_CONTINUITY_HOST="${OPENCLAW_CONTINUITY_HOST:-127.0.0.1}"
export OPENCLAW_CONTINUITY_PORT="${OPENCLAW_CONTINUITY_PORT:-18910}"

mkdir -p "$HOME/.airya/logs"
cd "$HOME/.airya/mcp" || exit 1

echo "[run-continuity-bridge.sh] Starting OpenClaw continuity bridge..."
echo "[run-continuity-bridge.sh] Node: $(node --version 2>&1)"
echo "[run-continuity-bridge.sh] CWD: $(pwd)"

exec node dist/openclaw-continuity-bridge.js "$@"
