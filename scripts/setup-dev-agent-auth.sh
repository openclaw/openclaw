#!/bin/bash
# Helper script to set up dev agent API key
# Usage: ANTHROPIC_API_KEY="sk-ant-..." ./scripts/setup-dev-agent-auth.sh

set -e

AGENT_DIR="$HOME/.openclaw-dev/agents/dev/agent"
AUTH_FILE="$AGENT_DIR/auth-profiles.json"

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "Error: ANTHROPIC_API_KEY environment variable not set."
  echo ""
  echo "Usage:"
  echo "  ANTHROPIC_API_KEY=\"sk-ant-...\" $0"
  echo ""
  echo "Or run interactively:"
  echo "  cd /Users/zhyr/work/openclaw"
  echo "  pnpm openclaw --dev agents add dev"
  echo "  (Then select 'Yes' to update, choose 'anthropic', and paste your API key)"
  exit 1
fi

mkdir -p "$AGENT_DIR"

# Create or update auth-profiles.json
if [ -f "$AUTH_FILE" ]; then
  # Update existing file (preserve other profiles if any)
  node -e "
    const fs = require('fs');
    const path = '$AUTH_FILE';
    const key = process.env.ANTHROPIC_API_KEY;
    let store = { version: 1, profiles: {} };
    try {
      store = JSON.parse(fs.readFileSync(path, 'utf-8'));
    } catch {}
    store.profiles = store.profiles || {};
    store.profiles['anthropic:default'] = {
      type: 'api_key',
      provider: 'anthropic',
      key: key
    };
    fs.writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    console.log('Updated auth-profiles.json with anthropic:default profile');
  "
else
  # Create new file
  node -e "
    const fs = require('fs');
    const path = '$AUTH_FILE';
    const key = process.env.ANTHROPIC_API_KEY;
    const store = {
      version: 1,
      profiles: {
        'anthropic:default': {
          type: 'api_key',
          provider: 'anthropic',
          key: key
        }
      }
    };
    fs.mkdirSync('$AGENT_DIR', { recursive: true, mode: 0o700 });
    fs.writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    console.log('Created auth-profiles.json with anthropic:default profile');
  "
fi

echo "✓ Auth profile created at: $AUTH_FILE"
echo ""
echo "You can now use the dev agent. Restart gateway:dev if it's running."
