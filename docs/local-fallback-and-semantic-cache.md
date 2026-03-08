# Local Model Fallback and Semantic Cache

This document describes the Local Model Fallback and Semantic Cache features added to OpenClaw.

## Overview

These features enhance OpenClaw's reliability and performance:

- **Local Model Fallback**: Automatically switches to local AI models (Ollama/LM Studio) when cloud APIs fail
- **Semantic Cache**: Stores query embeddings to serve cached responses for similar questions

## Local Model Fallback

### How It Works

When a request to a cloud API (e.g., Anthropic) fails with specific conditions:

- HTTP 429 (Rate Limited)
- HTTP 503/502/500 (Server Errors)
- Connection timeouts
- Authentication failures

The system automatically falls back to a configured local model provider.

### Configuration

Add to your `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    defaults: {
      localModelFallback: {
        enabled: true,
        provider: "ollama", // or "lmstudio"
        baseUrl: "http://127.0.0.1:11434",
        model: "llama3.2",
        timeoutMs: 60000,
        healthCheckIntervalMs: 30000,
        maxRetries: 3,
      },
    },
  },
}
```

### Supported Providers

- **Ollama**: `http://127.0.0.1:11434` (default)
- **LM Studio**: `http://127.0.0.1:1234` (OpenAI-compatible API)

### Health Monitoring

- Checks provider health every 30 seconds (configurable)
- Caches health status to avoid excessive requests
- Tracks consecutive failures
- Only triggers fallback when local provider is healthy

## Semantic Cache

### How It Works

1. Query is converted to an embedding vector using a local embedding model
2. Cache searches for similar previous queries using cosine similarity
3. If similarity ≥ threshold (default 0.85), cached response is returned
4. Otherwise, query proceeds to LLM and result is cached

### Configuration

Add to your `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    defaults: {
      semanticCache: {
        enabled: true,
        similarityThreshold: 0.85, // 0.0 to 1.0
        maxEntries: 10000,
        ttlMs: 604800000, // 7 days in milliseconds
        embeddingProvider: "ollama",
        embeddingModel: "nomic-embed-text",
        baseUrl: "http://127.0.0.1:11434",
        minQueryLength: 10,
        maxQueryLength: 2000,
      },
    },
  },
}
```

### Cache Behavior

- **Similarity Threshold**: Default 0.85 (85% similar). Higher = stricter matching
- **TTL**: Entries expire after 7 days (configurable)
- **Eviction**: When full, oldest 10% of entries are removed
- **Query Filtering**: Only caches queries between 10-2000 characters

### Storage

- **Primary**: SQLite database at `~/.openclaw/state/cache/semantic-cache.sqlite`
- **Fallback**: In-memory storage if SQLite unavailable
- **Per-agent**: Separate cache files when `agentId` is provided

### Embedding Providers

- **Ollama** (default): Local embedding models
  - Recommended: `nomic-embed-text` (768 dimensions)
  - Alternative: `all-minilm` (384 dimensions)

## Integration

Both features integrate with OpenClaw's existing systems:

- **Local Fallback**: Wraps `runWithModelFallback` to add local models as final fallback
- **Semantic Cache**: Can be integrated into `pi-embedded-runner` for query result caching

## Testing

Run the test suites:

```bash
# Local Model Fallback tests
pnpm test -- --run src/agents/local-model-fallback.test.ts

# Semantic Cache Store tests
pnpm test -- --run src/agents/semantic-cache-store.test.ts

# All related tests
pnpm test -- --run src/agents/local-model-fallback.test.ts src/agents/semantic-cache-store.test.ts src/agents/semantic-cache.test.ts
```

## Benefits

- **Cost Reduction**: Semantic cache eliminates redundant API calls
- **Latency Improvement**: Cached responses are instant
- **Reliability**: Local fallback ensures availability during outages
- **Privacy**: Local models keep data on your machine
- **Graceful Degradation**: System continues working even when cloud APIs fail
