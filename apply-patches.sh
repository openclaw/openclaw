#!/bin/bash
# Re-apply custom msteams patches after OpenClaw updates
# Source: ~/src/github/openclaw (branch: feat/msteams-thread-history-graph-api)
# Target: ~/.npm-global/lib/node_modules/openclaw/extensions/msteams/src/

set -e

REPO="$HOME/src/github/openclaw"
TARGET="$HOME/.npm-global/lib/node_modules/openclaw/extensions/msteams/src"

echo "📦 Applying msteams patches..."

cp "$REPO/extensions/msteams/src/graph.ts" "$TARGET/graph.ts"
cp "$REPO/extensions/msteams/src/monitor-handler/message-handler.ts" "$TARGET/monitor-handler/message-handler.ts"
cp "$REPO/extensions/msteams/src/attachments/graph.ts" "$TARGET/attachments/graph.ts"

echo "✅ Patches applied. Restart gateway to activate."
