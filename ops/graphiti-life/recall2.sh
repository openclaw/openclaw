#!/usr/bin/env bash
# Validate recall + isolation with RediSearch-safe (alnum/underscore) group ids.
set -uo pipefail
URL="http://172.17.0.1:8000/mcp"
HDR=$(mktemp); BODY=$(mktemp); SID=""
req() {
  curl -sS -D "$HDR" -o "$BODY" -X POST "$URL" \
    -H 'Host: localhost:8000' -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2024-11-05' \
    ${SID:+-H "Mcp-Session-Id: $SID"} -d "$1"
}
body() { grep '^data:' "$BODY" | sed 's/^data: //'; }
req '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"r2","version":"0"}}}'
SID=$(grep -i '^mcp-session-id:' "$HDR" | tr -d '\r' | awk '{print $2}')
req '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

echo "=== add_memory in tg_111 ==="
req '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add_memory","arguments":{"name":"dana profile","episode_body":"Dana lives in Tel Aviv and loves hiking.","group_id":"tg_111"}}}'
body
echo; echo "waiting 35s for processing..."; sleep 35

echo "=== search in tg_111 (should find Tel Aviv) ==="
req '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_memory_facts","arguments":{"query":"Where does Dana live?","group_ids":["tg_111"],"max_facts":5}}}'
body
echo; echo "=== ISOLATION: search in tg_222 (should be EMPTY) ==="
req '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_memory_facts","arguments":{"query":"Where does Dana live?","group_ids":["tg_222"],"max_facts":5}}}'
body
