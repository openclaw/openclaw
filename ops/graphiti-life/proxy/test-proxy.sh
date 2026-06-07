#!/usr/bin/env bash
# Drive graphiti-proxy.js (in a throwaway node container on Graphiti's network)
# through a sequence of MCP requests to validate the capability boundary.
set -uo pipefail
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  # (A) dangerous tool → must be rejected
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"clear_graph","arguments":{"__group_id":"tg_777"}}}'
  # (B) missing scope → must fail closed
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"add_memory","arguments":{"name":"x","episode_body":"y"}}}'
  # (C) model tries to inject center_node_uuid → silently stripped, call still works
  echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_memory_facts","arguments":{"__group_id":"tg_777","query":"anything","center_node_uuid":"deadbeef"}}}'
  # (D) proper scoped write
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"add_memory","arguments":{"__group_id":"tg_777","name":"profile","episode_body":"Noa works as a nurse in Haifa."}}}'
  sleep 12
} | docker run --rm -i --network graphiti-life_graphiti \
      -e GRAPHITI_URL=http://graphiti-mcp:8000/mcp \
      -e GRAPHITI_HOST_HEADER=localhost:8000 \
      -v /opt/graphiti/proxy:/p node:20-alpine node /p/graphiti-proxy.js
