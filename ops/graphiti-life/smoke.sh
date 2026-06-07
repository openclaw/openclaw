#!/usr/bin/env bash
# MCP streamable-HTTP smoke test against the local Graphiti server.
set -uo pipefail
URL="http://172.17.0.1:8000/mcp"
HDR=$(mktemp); BODY=$(mktemp)
SID=""
req() { # $1=json
  curl -sS -D "$HDR" -o "$BODY" -X POST "$URL" \
    -H 'Host: localhost:8000' \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2024-11-05' \
    ${SID:+-H "Mcp-Session-Id: $SID"} \
    -d "$1"
}
show() { echo "--- $1 ---"; grep '^data:' "$BODY" 2>/dev/null | sed 's/^data: //' || cat "$BODY"; echo; }

req '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
SID=$(grep -i '^mcp-session-id:' "$HDR" | tr -d '\r' | awk '{print $2}')
echo "session=$SID"; show "initialize"

req '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

req '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
echo "--- tools/list (names) ---"
grep '^data:' "$BODY" | sed 's/^data: //' | grep -o '"name":"[a-z_]*"' | sort -u
echo

req '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_memory","arguments":{"name":"smoke fact","episode_body":"Dana lives in Tel Aviv and loves hiking.","group_id":"smoke-userA"}}}'
show "add_memory (group smoke-userA)"

req '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_status","arguments":{}}}'
show "get_status"
