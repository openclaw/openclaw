#!/usr/bin/env bash
# post-execution-store.sh — Called after an OpenClaw agent completes a task.
# Stores execution results into agent-hub memory DAG for organizational learning.
#
# Usage:
#   echo "result text" | ./post-execution-store.sh
#   ./post-execution-store.sh "result text"
#   ./post-execution-store.sh "result text" "optional task description"
# Exit: always 0 (non-blocking)

set -o pipefail

# Read result from argument or stdin
if [[ -n "${1:-}" ]]; then
  RESULT="$1"
  TASK_DESC="${2:-}"
else
  RESULT=$(cat 2>/dev/null || echo "")
  TASK_DESC=""
fi

if [[ -z "$RESULT" ]]; then
  exit 0
fi

# Resolve API key: env var first, then .mcp.json
if [[ -z "${AGENT_HUB_API_KEY:-}" ]]; then
  MCP_JSON="/home/aali/openclaw/.mcp.json"
  if [[ -f "$MCP_JSON" ]]; then
    AGENT_HUB_API_KEY=$(node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$MCP_JSON','utf8'));
      const auth = cfg.mcpServers?.['agent-hub']?.headers?.Authorization || '';
      console.log(auth.replace(/^Bearer\s+/i, ''));
    " 2>/dev/null)
  fi
fi

if [[ -z "${AGENT_HUB_API_KEY:-}" ]]; then
  exit 0
fi

MCP_URL="https://agent-hub.pulsebusiness.ai/mcp"

# Build JSON payload via node (handles all escaping safely)
PAYLOAD=$(node -e "
  const result = process.argv[1].slice(0, 1000);
  const taskDesc = process.argv[2] || '';
  const ts = Date.now();
  const key = 'openclaw:result:' + ts;

  const metadata = {
    source_system: 'openclaw',
    category: 'execution-result',
    timestamp: new Date(ts).toISOString()
  };
  if (taskDesc) metadata.task_description = taskDesc.slice(0, 200);

  console.log(JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'store_memory',
      arguments: {
        key: key,
        content: result,
        metadata: metadata
      }
    },
    id: 1
  }));
" "$RESULT" "$TASK_DESC" 2>/dev/null)

if [[ -z "$PAYLOAD" ]]; then
  exit 0
fi

# Call agent-hub MCP endpoint (fire and forget, just check curl exits)
curl -sS --max-time 10 -X POST "$MCP_URL" \
  -H "Authorization: Bearer $AGENT_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true

exit 0
