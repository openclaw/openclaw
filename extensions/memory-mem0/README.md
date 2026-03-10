# memory-mem0

OpenClaw memory plugin backed by a self-hosted [Mem0](https://github.com/mem0ai/mem0) REST API.

Replaces the default LanceDB memory backend with Mem0's semantic extraction pipeline — your agents get long-term memory powered by any LLM for fact extraction and any embedding model for vector search.

## Features

- **Three agent tools**: `memory_recall`, `memory_store`, `memory_forget`
- **Auto-recall**: Injects relevant memories before each agent execution
- **Auto-capture**: Stores conversation highlights after each agent execution
- **CLI commands**: `openclaw mem0 search|list|forget`
- **Graceful degradation**: Logs warnings if the Mem0 server is unreachable, never crashes the gateway
- **Zero native dependencies**: Uses Node.js built-in `fetch()` — no SDK required

## Prerequisites

A running Mem0 REST API server. You can set one up with:

- [mem0ai](https://docs.mem0.ai/open-source/quickstart) (Python, self-hosted)
- Any HTTP server that implements the `/memories`, `/memories/search`, and `/health` endpoints

The plugin expects these REST endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/memories/search?query=...&user_id=...&limit=...` | Search memories |
| POST | `/memories` | Store a memory (`{ content, user_id, metadata }`) |
| GET | `/memories?user_id=...` | List all memories |
| DELETE | `/memories/:id` | Delete a memory |

## Installation

1. Copy this plugin to your OpenClaw user extensions directory:

   ```bash
   cp -r openclaw-memory-mem0 ~/.openclaw/extensions/memory-mem0
   cd ~/.openclaw/extensions/memory-mem0
   npm install
   ```

2. Add the plugin to your `~/.openclaw/openclaw.json`:

   ```json
   {
     "plugins": {
       "slots": {
         "memory": "memory-mem0"
       },
       "entries": {
         "memory-mem0": {
           "enabled": true,
           "config": {
             "baseUrl": "http://127.0.0.1:8420",
             "userId": "my-bot",
             "autoCapture": true,
             "autoRecall": true,
             "recallLimit": 5,
             "recallThreshold": 0.4
           }
         }
       }
     }
   }
   ```

   > **Note:** Use `127.0.0.1` instead of `localhost` — Node.js 22+ prefers IPv6 (`::1`), which will fail if your Mem0 server only binds IPv4.

3. Restart the gateway:

   ```bash
   systemctl --user restart openclaw-gateway
   ```

   You should see in the logs:
   ```
   [memory-mem0] Plugin registered (autoRecall=true, autoCapture=true)
   ```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | string | `http://127.0.0.1:8420` | Mem0 REST API base URL |
| `userId` | string | `openclaw` | User ID for memory partitioning |
| `autoCapture` | boolean | `true` | Store conversation context after agent execution |
| `autoRecall` | boolean | `true` | Inject relevant memories before agent execution |
| `recallLimit` | number | `5` | Max memories to inject per query |
| `recallThreshold` | number | `0.4` | Min relevance score for auto-recall (0.0 - 1.0) |

## Agent Tools

### memory_recall

Search long-term memory for relevant facts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `limit` | number | no | Max results (default: 5, max: 20) |

### memory_store

Store a new fact in long-term memory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | yes | Fact or context to remember |
| `agent_id` | string | no | Agent ID stored in metadata |

### memory_forget

Delete a specific memory by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Memory ID to delete |

## CLI Commands

```bash
# Search memories
openclaw mem0 search "project architecture"

# List all stored memories
openclaw mem0 list

# Delete a memory
openclaw mem0 forget <memory-id>
```

## How Auto-Recall Works

When `autoRecall` is enabled, the plugin hooks into `before_agent_start`:

1. The user's prompt is used as a search query against Mem0
2. Memories scoring above `recallThreshold` are selected
3. They are prepended to the agent context as:

   ```xml
   <relevant-memories>
   Relevant facts from long-term memory:
   - Some stored fact [score: 0.87]
   - Another relevant memory [score: 0.72]
   </relevant-memories>
   ```

## How Auto-Capture Works

When `autoCapture` is enabled, the plugin hooks into `agent_end`:

1. User and assistant messages from the conversation are extracted
2. Messages shorter than 50 characters are skipped
3. Messages containing `<relevant-memories>` are skipped (prevents feedback loops)
4. Remaining messages are sent to Mem0 for fact extraction and storage

## Switching from LanceDB

To use Mem0 instead of the default LanceDB memory:

1. Change `plugins.slots.memory` from `"memory-lancedb"` to `"memory-mem0"`
2. Your LanceDB config is preserved — swap back anytime by reverting the slot

Both plugins implement the same tool names (`memory_recall`, `memory_store`, `memory_forget`), so agents work identically regardless of which backend is active.

## Architecture

```
Agent
  ├── memory_recall ──→ GET  /memories/search ──→ Mem0 ──→ Vector DB
  ├── memory_store  ──→ POST /memories         ──→ Mem0 ──→ LLM extraction ──→ Vector DB
  └── memory_forget ──→ DELETE /memories/:id   ──→ Mem0 ──→ Vector DB
```

The plugin itself is a thin HTTP client — all the heavy lifting (LLM-based fact extraction, embedding generation, vector storage) happens in the Mem0 server.

## Roadmap

This plugin is the first step toward a broader goal: **a unified hybrid SQL + vector memory layer that works across multiple agent harnesses**.

Today's AI agent ecosystem is fragmented — Claude Code, OpenClaw, Cursor, Windsurf, custom Agent SDK builds, and others each maintain their own isolated memory. An agent's knowledge dies with its session or stays locked inside one platform. We want to fix that.

### Where we're headed

**Hybrid storage.** Semantic vector search is great for recall, but agents also need structured data — task history, entity relationships, configuration state. The next iteration will back the memory server with a hybrid SQL + vector database (likely SQLite + Qdrant, or a single engine like LanceDB that handles both), so agents can query memories relationally _and_ semantically.

**Harness-agnostic REST API.** The Mem0 REST interface already decouples memory from any specific agent framework. We plan to publish adapters for other harnesses beyond OpenClaw — Claude Code MCP servers, LangChain/LangGraph memory backends, CrewAI, and plain HTTP clients. Same memory, any agent.

**Cross-agent knowledge sharing.** Today each agent session is a silo. With a shared memory server, agents can build on each other's work — one agent discovers a codebase pattern, another recalls it weeks later in a different project. The `user_id` and `metadata` fields already support multi-tenant partitioning; we'll extend this with namespaces, access control, and provenance tracking.

**Tool and workflow integration.** Memory shouldn't just serve agents — it should feed into dashboards, search UIs, n8n workflows, and monitoring. The REST API is the foundation; we'll add webhooks, event streams, and export formats so memory becomes a shared resource across your entire automation stack.

**Intelligent lifecycle management.** Memories accumulate without bound today. Future versions will add decay, deduplication, contradiction resolution, and importance scoring — so the memory store stays relevant and doesn't degrade search quality over time.

### Contributing

If this aligns with what you're building, we'd love contributions — especially around:

- Adapters for other agent frameworks
- Hybrid SQL + vector storage backends
- Memory lifecycle and quality management
- Search UI and observability tooling

Open an issue to discuss your idea, or submit a PR.

## License

MIT
