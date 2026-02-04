# Memory (Redis) Plugin

Redis-backed long-term memory plugin for OpenClaw with vector similarity search.

## Requirements

- **Redis 8+** (includes Query Engine with vector search built-in)
- Embedding provider (OpenAI, Google Gemini, or local node-llama-cpp)

## Quick Start

### 1. Start Redis

Choose the option that matches your deployment:

#### Docker (recommended)

Works with any installation method (curl installer, npm, VPS, etc.):

```bash
# Simple one-liner - runs Redis Stack with persistence
docker run -d \
  --name redis-stack \
  -p 127.0.0.1:6379:6379 \
  -v redis-data:/data \
  --restart unless-stopped \
  redis/redis-stack:latest
```

For Docker Compose deployments, see [Docker Compose Setup](#docker-compose-setup) below.

#### Native Installation (Debian/Ubuntu)

If you prefer not to use Docker:

```bash
# Add Redis repository
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list

# Install Redis Stack (includes Query Engine for vector search)
sudo apt-get update
sudo apt-get install -y redis-stack-server

# Start and enable
sudo systemctl enable redis-stack-server
sudo systemctl start redis-stack-server
```

> **Note:** Redis Stack is required (not plain Redis) because it includes the Query Engine (RediSearch) for vector similarity search.

#### Docker Compose Setup

**Option A: With OpenClaw Docker deployment**

```bash
# From repo root - merges Redis with OpenClaw gateway
docker compose -f docker-compose.yml -f extensions/memory-redis/docker/docker-compose.yml up -d
```

This starts Redis alongside the gateway on a shared network. Use `redis://redis-stack:6379` as the Redis URL in your plugin config.

**Option B: Standalone compose (Redis only)**

```bash
cd extensions/memory-redis/docker && docker compose up -d
```

Access via `redis://localhost:6379` from your host.

### 2. Enable the Plugin

```bash
openclaw plugins enable memory-redis
```

### 3. Configure

**Option A: Local Embeddings (no API key needed)**

```json5
{
  plugins: {
    slots: { memory: "memory-redis" },
    entries: {
      "memory-redis": {
        config: {
          redis: { url: "redis://localhost:6379" },
          embedding: { provider: "local" },
          autoRecall: true,
          autoCapture: true,
        },
      },
    },
  },
}
```

**Option B: OpenAI Embeddings**

```json5
{
  plugins: {
    slots: { memory: "memory-redis" },
    entries: {
      "memory-redis": {
        config: {
          redis: { url: "${REDIS_URL}" },
          embedding: {
            provider: "openai",
            apiKey: "${OPENAI_API_KEY}",
            model: "text-embedding-3-small",
          },
          autoRecall: true,
          autoCapture: true,
        },
      },
    },
  },
}
```

**Option C: Auto (tries local first, falls back to OpenAI)**

```json5
{
  plugins: {
    slots: { memory: "memory-redis" },
    entries: {
      "memory-redis": {
        config: {
          redis: { url: "redis://localhost:6379" },
          embedding: {
            provider: "auto",
            fallback: "openai",
            apiKey: "${OPENAI_API_KEY}", // Only used if fallback triggers
          },
          autoRecall: true,
        },
      },
    },
  },
}
```

## Configuration Options

| Option               | Type    | Default                 | Description                                |
| -------------------- | ------- | ----------------------- | ------------------------------------------ |
| `redis.url`          | string  | required                | Redis connection URL                       |
| `redis.password`     | string  | -                       | Redis password (optional)                  |
| `redis.tls`          | boolean | false                   | Enable TLS connection                      |
| `embedding.provider` | string  | `auto`                  | `openai`, `gemini`, `local`, or `auto`     |
| `embedding.apiKey`   | string  | -                       | API key (required for openai/gemini)       |
| `embedding.model`    | string  | -                       | Embedding model (provider-specific)        |
| `embedding.baseUrl`  | string  | -                       | Custom API base URL (for Ollama/self-host) |
| `embedding.fallback` | string  | `none`                  | Fallback provider if primary fails         |
| `indexName`          | string  | `idx:openclaw:memories` | RediSearch index name                      |
| `keyPrefix`          | string  | `openclaw:memory`       | Redis key prefix                           |
| `autoCapture`        | boolean | false                   | Auto-capture important info                |
| `autoRecall`         | boolean | false                   | Auto-inject relevant memories              |

### Embedding Providers

| Provider | Default Model                    | Any Model?                          | API Key |
| -------- | -------------------------------- | ----------------------------------- | ------- |
| `openai` | `text-embedding-3-small`         | ✅ Yes, any OpenAI-compatible model | Yes     |
| `gemini` | `gemini-embedding-001`           | ✅ Yes, any Gemini embedding model  | Yes     |
| `local`  | `embeddinggemma-300M-Q8_0.gguf`  | ✅ Yes, any GGUF embedding model    | No      |
| `auto`   | Tries local first, then fallback | -                                   | Depends |

### Self-Hosted Embeddings with Ollama

You can use Ollama as a self-hosted embedding provider. Ollama exposes an OpenAI-compatible API.

**Setup Ollama on your server:**

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Configure to listen on all interfaces (edit systemd service)
sudo systemctl edit ollama
# Add: Environment="OLLAMA_HOST=0.0.0.0"

# Restart and pull embedding model
sudo systemctl restart ollama
ollama pull nomic-embed-text
```

**Configure the plugin to use Ollama:**

```json5
{
  plugins: {
    slots: { memory: "memory-redis" },
    entries: {
      "memory-redis": {
        config: {
          redis: { url: "redis://localhost:6379" },
          embedding: {
            provider: "openai",
            apiKey: "ollama", // Ollama ignores this but it's required
            model: "nomic-embed-text",
            baseUrl: "http://192.168.178.10:11434/v1",
          },
          autoRecall: true,
        },
      },
    },
  },
}
```

**Supported Ollama embedding models:**

| Model               | Dimensions | Size   | Notes                            |
| ------------------- | ---------- | ------ | -------------------------------- |
| `nomic-embed-text`  | 768        | ~275MB | Best balance of quality and size |
| `mxbai-embed-large` | 1024       | ~670MB | Higher quality, larger           |
| `all-minilm`        | 384        | ~46MB  | Fast, smaller, lower quality     |

## Agent Tools

The plugin registers these tools for the AI agent:

- **memory_recall** - Search memories by semantic similarity
- **memory_store** - Store new memories with category and importance
- **memory_forget** - Delete memories (GDPR-compliant)

## CLI Commands

```bash
# List memory count
openclaw redis-memory list

# Search memories
openclaw redis-memory search "user preferences"

# Show statistics
openclaw redis-memory stats

# Delete a memory
openclaw redis-memory delete <uuid>
```

## How It Works

### Storage

Memories are stored as JSON documents in Redis with vector embeddings:

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

### Vector Search

Uses RediSearch's HNSW (Hierarchical Navigable Small World) algorithm for fast approximate nearest neighbor search with cosine similarity.

### Auto-Recall

When enabled, searches for relevant memories before each agent interaction and injects them into the context.

### Auto-Capture

When enabled, analyzes conversations for important information (preferences, facts, decisions, contact info) and automatically stores them.

## Development

### Run Tests

```bash
# Unit tests (no Redis needed)
pnpm vitest run --config vitest.extensions.config.ts extensions/memory-redis

# Live tests (requires Redis)
# With local embeddings (no API key needed):
LIVE=1 REDIS_URL=redis://localhost:6379 pnpm vitest run --config vitest.extensions.config.ts extensions/memory-redis

# With OpenAI embeddings:
LIVE=1 REDIS_URL=redis://localhost:6379 OPENAI_API_KEY=sk-... pnpm vitest run --config vitest.extensions.config.ts extensions/memory-redis
```

## License

MIT
