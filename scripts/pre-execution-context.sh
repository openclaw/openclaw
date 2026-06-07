#!/usr/bin/env bash
# pre-execution-context.sh — Called before an OpenClaw agent starts a task.
# Fetches relevant organizational context from agent-hub memory DAG
# and outputs it to stdout for injection into the agent prompt.
#
# Usage: ./pre-execution-context.sh "Fix the authentication bug in login flow"
# Exit: always 0 (non-blocking)

set -o pipefail

TASK="${1:-}"
if [[ -z "$TASK" ]]; then
  echo "[ORGANIZATIONAL CONTEXT - from agent-hub memory DAG]"
  echo "(no task description provided — skipping context lookup)"
  echo "[END CONTEXT]"
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
  echo "[ORGANIZATIONAL CONTEXT - from agent-hub memory DAG]"
  echo "(unable to resolve API key — skipping context lookup)"
  echo "[END CONTEXT]"
  exit 0
fi

MCP_URL="https://agent-hub.pulsebusiness.ai/mcp"

# Build JSON payload safely via node
PAYLOAD=$(node -e "
  const task = process.argv[1];
  console.log(JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'memory_search',
      arguments: { query: task, limit: 5 }
    },
    id: 1
  }));
" "$TASK" 2>/dev/null)

if [[ -z "$PAYLOAD" ]]; then
  echo "[ORGANIZATIONAL CONTEXT - from agent-hub memory DAG]"
  echo "(failed to build request payload)"
  echo "[END CONTEXT]"
  exit 0
fi

# Call agent-hub MCP endpoint
RAW_RESPONSE=$(curl -sS --max-time 15 -X POST "$MCP_URL" \
  -H "Authorization: Bearer $AGENT_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null) || {
  echo "[ORGANIZATIONAL CONTEXT - from agent-hub memory DAG]"
  echo "(agent-hub unreachable — skipping context lookup)"
  echo "[END CONTEXT]"
  exit 0
}

# Parse the SSE response. Lines look like:
#   event: message
#   data: {"jsonrpc":"2.0","result":{"content":[...]}}
#
# Extract the last data: line that contains valid JSON with result.content
OUTPUT=$(node -e "
  const raw = process.argv[1];
  const lines = raw.split('\n');
  let lastData = null;

  for (const line of lines) {
    const m = line.match(/^data:\s*(.+)/);
    if (m) {
      try {
        const obj = JSON.parse(m[1]);
        if (obj.result) lastData = obj;
      } catch {}
    }
  }

  // If no SSE framing, try parsing the whole response as JSON
  if (!lastData) {
    try {
      const obj = JSON.parse(raw);
      if (obj.result) lastData = obj;
    } catch {}
  }

  if (!lastData || !lastData.result) {
    console.log('[ORGANIZATIONAL CONTEXT - from agent-hub memory DAG]');
    console.log('(no results returned)');
    console.log('[END CONTEXT]');
    process.exit(0);
  }

  const content = lastData.result.content || [];
  const parts = [];

  for (const item of content) {
    if (item.type === 'text' && item.text) {
      // Try to parse text as JSON (memory_search returns structured data)
      try {
        const memories = JSON.parse(item.text);
        if (Array.isArray(memories)) {
          for (const mem of memories) {
            const c = mem.content || mem.text || mem.value || JSON.stringify(mem);
            const src = mem.source_system || mem.source || mem.metadata?.source_system || 'unknown';
            const score = mem.score || mem.relevance || mem.similarity || 'n/a';
            parts.push({ content: c, source: src, score });
          }
        } else if (typeof memories === 'object') {
          const results = memories.results || memories.memories || memories.items || [memories];
          for (const mem of (Array.isArray(results) ? results : [results])) {
            const c = mem.content || mem.text || mem.value || JSON.stringify(mem);
            const src = mem.source_system || mem.source || mem.metadata?.source_system || 'unknown';
            const score = mem.score || mem.relevance || mem.similarity || 'n/a';
            parts.push({ content: c, source: src, score });
          }
        }
      } catch {
        // Plain text result
        parts.push({ content: item.text, source: 'agent-hub', score: 'n/a' });
      }
    }
  }

  let output = '[ORGANIZATIONAL CONTEXT - from agent-hub memory DAG]\n';
  if (parts.length === 0) {
    output += '(no relevant memories found)\n';
  } else {
    for (let i = 0; i < parts.length && i < 5; i++) {
      const p = parts[i];
      // Truncate individual memory content to keep total output reasonable
      const truncated = String(p.content).slice(0, 350).replace(/\n/g, ' ');
      output += (i + 1) + '. ' + truncated + ' (source: ' + p.source + ', relevance: ' + p.score + ')\n';
    }
  }
  output += '[END CONTEXT]';

  // Enforce 2000 char limit
  if (output.length > 2000) {
    output = output.slice(0, 1990) + '...\n[END CONTEXT]';
  }

  console.log(output);
" "$RAW_RESPONSE" 2>/dev/null) || {
  echo "[ORGANIZATIONAL CONTEXT - from agent-hub memory DAG]"
  echo "(failed to parse response)"
  echo "[END CONTEXT]"
  exit 0
}

echo "$OUTPUT"
exit 0
