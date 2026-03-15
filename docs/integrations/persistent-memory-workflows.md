---
title: Persistent Memory Workflows
description: Architecture and patterns for Claude-based persistent memory with OpenClaw
---

# Persistent Memory Workflows

OpenClaw enables persistent memory workflows for Claude-based applications,
allowing context to persist across sessions, agents, and channels.

## Architecture Overview

```
+------------------+     +-------------------+     +------------------+
|   Claude Code    |     |   OpenClaw MCP    |     |   OpenClaw       |
|   / Browser      | --> |   Server          | --> |   Gateway        |
+------------------+     +-------------------+     +------------------+
                                                          |
                         +--------------------------------+
                         |
                   +-----v-----+     +-----------------+
                   |  Memory   |     |   Agent         |
                   |  Backend  |     |   Sessions      |
                   +-----------+     +-----------------+
```

## Memory Types

### Semantic Memory

Long-term knowledge storage with vector embeddings:

```json5
{
  "memory": {
    "semantic": {
      "enabled": true,
      "backend": "qmd",
      "embedding": {
        "provider": "voyage",
        "model": "voyage-3"
      }
    }
  }
}
```

### Episodic Memory

Session-based memory for conversation history:

```json5
{
  "memory": {
    "episodic": {
      "enabled": true,
      "retention": "7d",
      "maxTokens": 100000
    }
  }
}
```

### Working Memory

Short-term context within a conversation:

```json5
{
  "memory": {
    "working": {
      "enabled": true,
      "windowSize": 20,
      "compaction": "smart"
    }
  }
}
```

## Workflow Patterns

### 1. Knowledge Accumulation

Build persistent knowledge from conversations:

```typescript
// Automatically extract and store insights
const workflow = {
  triggers: ["conversation_end", "explicit_save"],
  extraction: {
    patterns: ["user_preference", "technical_decision", "project_context"],
    model: "claude-haiku-4-5"
  },
  storage: {
    deduplication: true,
    updateExisting: true
  }
};
```

### 2. Context Retrieval

Automatically inject relevant context:

```typescript
// Before each response, search memory
const retrieval = {
  trigger: "before_response",
  search: {
    query: "current_message",
    limit: 5,
    threshold: 0.7
  },
  injection: {
    position: "system_prompt",
    format: "context_block"
  }
};
```

### 3. Cross-Session Continuity

Maintain state across sessions:

```typescript
// Resume context from previous session
const continuity = {
  sessionLinking: true,
  contextCarryover: {
    enabled: true,
    maxAge: "24h",
    relevanceDecay: 0.9
  }
};
```

### 4. Multi-Agent Memory Sharing

Share memory between agents:

```typescript
// Agents can read shared memory
const sharing = {
  scope: "workspace",
  permissions: {
    "agent:main": "read_write",
    "agent:research": "read_only",
    "agent:code": "read_write"
  }
};
```

## Configuration Templates

### Basic Setup

Minimal configuration for persistent memory:

```json5
{
  "memory": {
    "enabled": true,
    "backend": "local",
    "autoSync": true
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "memorySearch": {
          "enabled": true,
          "autoInject": true
        }
      }
    ]
  }
}
```

### Advanced Setup

Full-featured configuration:

```json5
{
  "memory": {
    "enabled": true,
    "backend": {
      "type": "qmd",
      "embedding": {
        "provider": "voyage",
        "model": "voyage-3"
      }
    },
    "semantic": {
      "enabled": true,
      "threshold": 0.75,
      "maxResults": 10
    },
    "episodic": {
      "enabled": true,
      "retention": "30d"
    },
    "sync": {
      "auto": true,
      "interval": "5m",
      "onShutdown": true
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "memorySearch": {
          "enabled": true,
          "autoInject": true,
          "contextWindow": 8000
        },
        "subagents": {
          "enabled": true,
          "memorySharing": true
        }
      }
    ]
  }
}
```

## Memory Operations

### Adding Memories

```bash
# CLI
openclaw memory add "User prefers TypeScript"

# Via MCP tool
{
  "tool": "openclaw_memory_add",
  "content": "User prefers TypeScript",
  "metadata": { "source": "preference" }
}
```

### Searching Memory

```bash
# CLI
openclaw memory search "coding preferences"

# Via MCP tool
{
  "tool": "openclaw_memory_search",
  "query": "coding preferences",
  "limit": 5
}
```

### Memory Management

```bash
# List all memories
openclaw memory list

# Export memories
openclaw memory export --format json > memories.json

# Import memories
openclaw memory import memories.json

# Clear memories
openclaw memory clear --confirm
```

## Integration with Claude Code

### Automatic Memory Injection

Configure Claude Code to automatically inject relevant memories:

```json5
// ~/.config/claude-code/settings.json
{
  "mcpServers": {
    "openclaw": {
      "command": "openclaw",
      "args": ["mcp", "serve"],
      "memoryInjection": {
        "enabled": true,
        "beforeEachPrompt": true
      }
    }
  }
}
```

### Browser Integration

Enable memory access from browser:

```javascript
// Browser client
const mcp = new McpClient('ws://127.0.0.1:8765');

// Search memories
const results = await mcp.callTool('openclaw_memory_search', {
  query: 'project requirements',
  limit: 5
});

// Add to memory
await mcp.callTool('openclaw_memory_add', {
  content: 'New requirement: support dark mode',
  metadata: { type: 'requirement', priority: 'high' }
});
```

## Best Practices

### 1. Memory Hygiene

Regularly prune outdated or irrelevant memories:

```json5
{
  "memory": {
    "hygiene": {
      "enabled": true,
      "pruneAfter": "90d",
      "deduplication": "weekly"
    }
  }
}
```

### 2. Categorization

Use metadata for better retrieval:

```typescript
// Good: categorized memory
await memoryAdd({
  content: "API uses JWT authentication",
  metadata: {
    category: "technical",
    project: "auth-service",
    tags: ["api", "security", "jwt"]
  }
});
```

### 3. Context Relevance

Configure relevance thresholds:

```json5
{
  "memory": {
    "retrieval": {
      "threshold": 0.75,
      "recencyBias": 0.1,
      "maxAge": "30d"
    }
  }
}
```

### 4. Privacy Considerations

Control what gets stored:

```json5
{
  "memory": {
    "filters": {
      "exclude": ["password", "secret", "token", "key"],
      "piiDetection": true,
      "anonymize": true
    }
  }
}
```

## Troubleshooting

### Memory Not Persisting

Check backend status:

```bash
openclaw memory status
```

### Search Returns No Results

Verify embeddings are working:

```bash
openclaw memory probe "test query"
```

### High Latency

Check memory size and optimize:

```bash
openclaw memory stats
openclaw memory optimize
```

## Related Documentation

- [Memory System Concepts](/concepts/memory)
- [MCP Server Integration](/integrations/mcp)
- [Claude Code Subagents](/integrations/claude-code-subagents)
- [Agent Configuration](/concepts/agent)
