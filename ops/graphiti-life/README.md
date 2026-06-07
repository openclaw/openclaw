# Graphiti per-user memory for the `life` agent

Self-hosted [Graphiti](https://github.com/getzep/graphiti) + FalkorDB stack that
gives the `life` agent durable, per-user memory. Implements Phase 1 of
`docs/experiments/plans/life-per-user-memory.md`.

**Host:** US agent host `5.161.84.219`, directory `/opt/graphiti`.
**Status:** Phase 1 (this stack) deployed & smoke-tested. Phases 2–3 (scoping
proxy + `life` wiring) are in `proxy/` and `docs/` here, staged for rollout.

## Architecture

```
life gateway container (life_default net)
   └─ mcp-bridge spawns → graphiti-proxy.js (node, stdio)   [Phase 2]
        └─ HTTP → graphiti-mcp :8000  (this stack)
             └─ FalkorDB (graph + vectors)
```

Graphiti runs as its own compose project (`graphiti-life`), isolated from the
per-agent gateway containers. mcp-bridge cannot spawn Graphiti directly (it's a
Python/uv app needing FalkorDB), so a lightweight Node **proxy** bridges
stdio↔HTTP _and_ enforces the security boundary (see `proxy/`).

## Services (`docker-compose.yml`)

| Service        | Image                                  | Exposure                                                           |
| -------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `falkordb`     | `falkordb/falkordb:latest`             | internal only (graph net), password via `REDIS_ARGS=--requirepass` |
| `graphiti-mcp` | `zepai/knowledge-graph-mcp:standalone` | `172.17.0.1:8000` (docker0 bridge, **never** 0.0.0.0)              |

LLM/embedder: OpenAI (`gpt-4o-mini` extractor + `text-embedding-3-small`), key
sourced from `/root/.openclaw/agents/life/docker.env` into `.env` here.

## Deploy / operate

```bash
cd /opt/graphiti
cp .env.example .env        # then fill FALKORDB_PASSWORD (openssl rand -hex 24) + OPENAI_API_KEY
docker compose up -d
docker compose ps           # both healthy
docker logs graphiti-mcp --tail 30
./smoke.sh                  # initialize + tools/list + add_memory + get_status
./recall2.sh                # add → recall → cross-group isolation
```

## Gotchas discovered during Phase 1 (important for the proxy)

1. **Endpoint path is `/mcp` (no trailing slash).** `/mcp/` 307-redirects and
   curl drops the POST body.
2. **DNS-rebind protection:** the server rejects any non-localhost `Host` header
   with `421 Misdirected Request`. Clients MUST send `Host: localhost:8000`
   (the proxy sets this explicitly when connecting over the docker network).
3. **`group_id` must be RediSearch-safe:** alphanumeric + underscore only.
   Hyphens/colons break search (`RediSearch: Syntax error`). Canonical user keys
   are therefore **`tg_<from.id>`** and **`app_<appUserId>`** (underscore, not
   `tg:`/`app:` as the plan originally wrote).
4. **`add_memory` is async** (queued); facts are searchable a few seconds later
   after the extractor LLM + embedder run.

## Tool surface (confirmed from live `tools/list`)

Safe (group-scoped): `add_memory` (`group_id`), `search_nodes` / `search_memory_facts`
/ `get_episodes` (`group_ids`), `get_status`.
Dangerous (no group scope / destructive): `get_entity_edge`, `delete_entity_edge`,
`delete_episode`, `clear_graph`. The Phase 2 proxy exposes ONLY the safe read/write
tools and hard-pins `group_id`; the dangerous four are never exposed to the model.

## MCP handshake reference (streamable-HTTP)

```
POST http://172.17.0.1:8000/mcp
  Host: localhost:8000
  Content-Type: application/json
  Accept: application/json, text/event-stream
  MCP-Protocol-Version: 2024-11-05
  body: {"jsonrpc":"2.0","id":1,"method":"initialize",...}
→ 200, header `mcp-session-id: <id>`, SSE body `data: {...}`
Subsequent calls echo `Mcp-Session-Id: <id>`.
```
