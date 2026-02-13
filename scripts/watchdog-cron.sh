#!/bin/bash

# Dumb Watchdog Cron Wrapper
# Use this in crontab:
# */60 * * * * /path/to/repo/openclaw/scripts/watchdog-cron.sh

# 1. Setup minimal environment for Bun & OpenClaw CLI
# Attempt to find user home dynamically if not set
if [ -z "$HOME" ]; then
  export HOME=$(getent passwd $(whoami) | cut -d: -f6)
fi

# Add common paths for Bun/Node/Homebrew
export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ | tail -n1)/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# 2. Navigate to repo root (one level up from scripts/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 1

# 3. Run the TypeScript watchdog
# (Assumes `bun` is in PATH now)
echo "[$(date)] Running Watchdog..."
if ! command -v bun &> /dev/null; then
    echo "Error: bun not found in PATH: $PATH"
    exit 1
fi

bun scripts/watchdog.ts >> /tmp/openclaw-watchdog.log 2>&1
exit_code=$?
echo "[$(date)] Watchdog finished with status $exit_code"
exit $exit_code
