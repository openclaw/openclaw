---
summary: "Redis-backed long-term memory plugin with vector similarity search"
read_when:
  - You want to use Redis for agent memory instead of file-based storage
  - You need shared memory across multiple gateway instances
  - You want auto-capture and auto-recall of conversation facts
---

# Memory (Redis)

Redis-backed long-term memory plugin with vector similarity search. An alternative
to the file-based memory system for deployments that need:

- **Structured storage**: Memories stored as JSON documents, not Markdown files
- **Fast vector search**: RediSearch HNSW indexes for semantic similarity
- **Auto-capture**: Automatically extracts facts, preferences, and entities from conversations
- **Auto-recall**: Injects relevant memories into context before each agent turn
- **Shared state**: Works across multiple gateway instances via shared Redis

## Requirements

- **Redis 8+** or **Redis Stack** (includes RediSearch for vector search)
- Embedding provider: local (Ollama), OpenAI, or Gemini

## Quick Start

### 1. Start Redis

```bash
docker run -d --name redis-stack -p 127.0.0.1:6379:6379 \
  -v redis-data:/data --restart unless-stopped redis/redis-stack:latest
```

### 2. Configure

Add to your `openclaw.json`:

```json5
{
  plugins: {
    slots: { memory: "memory-redis" },
    entries: {
      "memory-redis": {
        config: {
          redis: { url: "redis://localhost:6379" },
          embedding: { provider: "local" }, // or openai/gemini
          autoRecall: true,
          autoCapture: true,
        },
      },
    },
  },
}
```

### 3. Restart Gateway

```bash
openclaw gateway restart
```

## Configuration

| Option               | Type    | Default                 | Description                                    |
| -------------------- | ------- | ----------------------- | ---------------------------------------------- |
| `redis.url`          | string  | required                | Redis connection URL                           |
| `redis.password`     | string  | -                       | Redis password (optional)                      |
| `redis.tls`          | boolean | false                   | Enable TLS connection                          |
| `embedding.provider` | string  | `auto`                  | `openai`, `gemini`, `local`, or `auto`         |
| `embedding.apiKey`   | string  | -                       | API key (required for openai/gemini)           |
| `embedding.model`    | string  | -                       | Embedding model (provider-specific)            |
| `embedding.baseUrl`  | string  | -                       | Custom API base URL (for Ollama)               |
| `embedding.fallback` | string  | `none`                  | Fallback provider if primary fails             |
| `indexName`          | string  | `idx:openclaw:memories` | RediSearch index name                          |
| `keyPrefix`          | string  | `openclaw:memory`       | Redis key prefix                               |
| `autoCapture`        | boolean | false                   | Auto-capture important info from conversations |
| `autoRecall`         | boolean | false                   | Auto-inject relevant memories before each turn |

## Embedding Providers

| Provider | Default Model                    | API Key Required |
| -------- | -------------------------------- | ---------------- |
| `openai` | `text-embedding-3-small`         | Yes              |
| `gemini` | `gemini-embedding-001`           | Yes              |
| `local`  | `embeddinggemma-300M-Q8_0.gguf`  | No               |
| `auto`   | Tries local first, then fallback | Depends          |

### Using Ollama (self-hosted)

Ollama exposes an OpenAI-compatible API:

```bash
# Install and start Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text
```

```json5
{
  embedding: {
    provider: "openai",
    apiKey: "ollama", // ignored but required
    model: "nomic-embed-text",
    baseUrl: "http://localhost:11434/v1",
  },
}
```

## Agent Tools

The plugin provides these tools to the AI agent:

- **memory_store** - Store facts, preferences, decisions with category and importance
- **memory_recall** - Search memories by semantic similarity
- **memory_forget** - Delete memories (GDPR-compliant)

## CLI Commands

```bash
# List memory count
openclaw redis-memory list

# Search memories
openclaw redis-memory search "user preferences"

# Show statistics (index info, embedding provider)
openclaw redis-memory stats

# Delete a memory by ID
openclaw redis-memory delete <uuid>
```

## How It Works

### Storage

Memories are stored as JSON documents in Redis:

```json
{
  "id": "uuid",
  "text": "User prefers dark mode",
  "vector": [0.1, 0.2, ...],
  "importance": 0.7,
  "category": "preference",
  "createdAt": 1706889600000
}
```

### Auto-Recall

When enabled, the plugin:

1. Embeds the user's prompt
2. Searches for semantically similar memories
3. Injects relevant memories into the context before the agent runs

### Auto-Capture

When enabled, the plugin analyzes completed conversations and automatically
stores important information (preferences, facts, decisions, contact info).

## Docker Compose

For Docker deployments, merge the plugin's compose file:

```bash
docker compose -f docker-compose.yml \
  -f extensions/memory-redis/docker/docker-compose.yml up -d
```

Then use `redis://redis-stack:6379` as the Redis URL.

## Comparison with File-Based Memory

| Feature        | File-Based (default) | Redis                |
| -------------- | -------------------- | -------------------- |
| Storage        | Markdown files       | Redis JSON documents |
| Search         | SQLite/QMD           | RediSearch vectors   |
| Multi-instance | ❌ (local files)     | ✅ (shared Redis)    |
| Auto-capture   | ❌                   | ✅                   |
| Auto-recall    | ❌                   | ✅                   |
| Human-editable | ✅ (plain text)      | ❌ (API only)        |

Choose Redis when you need shared state or automatic memory management.
Stick with file-based for simplicity and human-editable memory.
