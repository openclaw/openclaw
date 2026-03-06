---
title: "Cortex Memory Backend"
summary: "Configure Cortex Memory as an alternative memory backend for advanced semantic search"
read_when:
  - You want to use Cortex Memory instead of the builtin memory system
  - You need multi-tenant memory isolation
  - You want three-tier memory hierarchy (L0/L1/L2)
---

# Cortex Memory Backend

Cortex Memory is a high-performance, persistent, and intelligent long-term memory
system that can be used as an alternative to OpenClaw's builtin memory backend.

## What is Cortex Memory?

Cortex Memory is an external memory service that provides:

- **Three-tier memory hierarchy**: L0 Abstract → L1 Overview → L2 Detail
- **Virtual filesystem**: Memory content stored using `cortex://` URI scheme
- **Vector-based semantic search**: Powered by Qdrant with weighted L0/L1/L2 scoring
- **Multi-tenancy support**: Isolated memory spaces for different users and agents
- **Automatic memory extraction**: LLM-powered analysis with confidence scoring
- **Session management**: Track conversation timelines and message history

## When to Use Cortex Memory

Consider using Cortex Memory when:

- You need **multi-tenant memory isolation** (different users/agents with separate memory)
- You want **advanced semantic search** with hierarchical layer scoring
- You need **automatic memory extraction** from conversations
- You prefer a **separate memory service** that can be scaled independently

## Prerequisites

Before configuring Cortex Memory:

1. **Install Cortex Memory Service**: Follow the [Cortex Memory installation guide](https://github.com/sopaco/cortex-mem)

2. **Start the service**:
   ```bash
   cortex-mem-service --data-dir ./cortex-data --port 8085
   ```

3. **Configure Qdrant**: Cortex Memory requires a Qdrant vector database

4. **Configure LLM provider**: Cortex Memory needs an OpenAI-compatible LLM endpoint for memory extraction

## Configuration

Enable Cortex Memory by setting the backend and configuring the connection:

```json5
{
  memory: {
    backend: "cortex",
    cortex: {
      // URL of the Cortex Memory service (default: http://localhost:8085)
      serviceUrl: "http://localhost:8085",
      
      // Tenant identifier for memory isolation
      // Each tenant has completely separate memory spaces
      tenant: "my-agent",
      
      // API key for authentication (optional)
      apiKey: "your-api-key",
      
      // Request timeout in milliseconds (default: 30000)
      timeoutMs: 30000,
      
      // Maximum search results (default: 10)
      maxResults: 10,
      
      // Minimum relevance score threshold 0.0-1.0 (default: 0.4)
      minScore: 0.4,
      
      // Search scope: "session", "user", or "agent" (default: "session")
      scope: "session",
      
      // Auto-create sessions when adding messages (default: true)
      autoCreateSession: true,
      
      // Auto-extract memories when sessions close (default: true)
      autoExtract: true
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serviceUrl` | string | `http://localhost:8085` | URL of the Cortex Memory service |
| `tenant` | string | `default` | Tenant identifier for memory isolation |
| `apiKey` | string | - | API key for authentication (optional) |
| `timeoutMs` | number | `30000` | Request timeout in milliseconds |
| `maxResults` | number | `10` | Maximum number of search results |
| `minScore` | number | `0.4` | Minimum relevance score (0.0-1.0) |
| `scope` | string | `session` | Search scope: `session`, `user`, or `agent` |
| `autoCreateSession` | boolean | `true` | Auto-create sessions when adding messages |
| `autoExtract` | boolean | `true` | Auto-extract memories when sessions close |

### Search Scopes

Cortex Memory supports three search scopes:

- **session**: Search within conversation sessions (timeline, messages)
- **user**: Search user preferences, entities, and events
- **agent**: Search agent cases, skills, and knowledge

## How It Works

When Cortex Memory is configured:

1. **Search requests** are sent to the Cortex Memory service via REST API
2. **Memory files** are stored using the `cortex://` virtual filesystem
3. **Semantic search** uses Qdrant with weighted L0/L1/L2 scoring
4. **Automatic fallback**: If Cortex Memory is unavailable, OpenClaw falls back to the builtin memory system

### Three-Tier Memory Hierarchy

Cortex Memory implements a progressive disclosure system:

| Layer | Purpose | Token Usage | Weight |
|-------|---------|-------------|--------|
| **L0 (Abstract)** | Fast positioning, coarse-grained candidate selection | ~100 tokens | 20% |
| **L1 (Overview)** | Structured summary with key points and entities | ~500-2000 tokens | 30% |
| **L2 (Detail)** | Full conversation content | Variable | 50% |

This tiered approach optimizes LLM context window usage by loading only the necessary detail level.

### Fallback Behavior

If the Cortex Memory service is unavailable:

1. OpenClaw logs a warning
2. Automatically falls back to the builtin memory system
3. Continues operation without interruption
4. Retries Cortex Memory on the next session

## Example Configuration

Here's a complete example configuration:

```json5
{
  agents: {
    defaults: {
      memory: {
        backend: "cortex",
        cortex: {
          serviceUrl: "http://localhost:8085",
          tenant: "production-agent",
          maxResults: 8,
          minScore: 0.5,
          scope: "session"
        }
      }
    }
  }
}
```

## Monitoring

Check the Cortex Memory backend status:

```bash
openclaw memory status
```

This shows:
- Backend type: `cortex`
- Service URL
- Tenant ID
- Health status
- Configuration details

## Troubleshooting

### Service Unavailable

If you see "cortex memory unavailable; falling back to builtin":

1. Verify the Cortex Memory service is running
2. Check the `serviceUrl` configuration
3. Ensure network connectivity
4. Check service logs for errors

### Authentication Errors

If authentication fails:

1. Verify the `apiKey` is correct
2. Check the Cortex Memory service authentication configuration
3. Ensure the API key has the required permissions

### Low Search Relevance

If search results seem irrelevant:

1. Lower the `minScore` threshold
2. Increase `maxResults` for more candidates
3. Check if the search scope matches your data
4. Verify the Cortex Memory service has indexed your content

## See Also

- [Memory Overview](/concepts/memory) — Core memory concepts
- [Cortex Memory GitHub](https://github.com/sopaco/cortex-mem) — Official repository
- [Cortex Memory Documentation](https://github.com/sopaco/cortex-mem/tree/main/litho.docs) — Detailed documentation
