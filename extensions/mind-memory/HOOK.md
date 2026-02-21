---
name: Graphiti Memory Search
description: Allows the agent to consciously search the Graphiti knowledge graph for memories, facts, and entities.
version: 1.0.0
---

# Graphiti Memory Search Hook

This hook provides tools for the agent to consciously query the Graphiti temporal knowledge graph.

## Available Tools

### `remember`
Search the long-term knowledge graph for memories, facts, and entities related to a query.

**Use when:** You need to explicitly recall information from previous conversations or specific details about the user that might not be in the immediate context.

**Example:**
```
User: "What do you know about my project?"
Agent uses: remember(query: "user's project")
```

### `journal_memory_search`
Semantically search MEMORY.md (facts, data, decisions) and memory/*.md (daily logs) for relevant information.

**Use when:** You need to find specific information from structured memory files or daily logs.

**Example:**
```
User: "What technologies am I using?"
Agent uses: journal_memory_search(query: "technologies user is using")
```

### `journal_memory_get`
Read specific snippets from memory files with optional line range.

**Use when:** You need to pull exact content from memory files after finding relevant sections.

**Example:**
```
After search: journal_memory_get(path: "MEMORY.md", from: 42, lines: 10)
```

## How It Works

1. **Automatic Flashbacks**: The system automatically retrieves relevant memories based on conversation context (passive recall)
2. **Conscious Search**: The agent can actively search for specific information using these tools (active recall)

## Integration

This hook is automatically registered by the `mind-memory` plugin and uses the Graphiti MCP server running at `http://localhost:8001`.
