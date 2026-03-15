---
summary: "Guide for using Claude Code subagents with OpenClaw"
read_when:
  - Setting up Claude Code integration
  - Configuring subagents for OpenClaw workflows
title: "Claude Code Subagents"
---

# Claude Code Subagents

This guide covers how to use Claude Code's subagent system with OpenClaw for enhanced AI-assisted workflows.

## Overview

Claude Code supports launching specialized subagents for complex, multi-step tasks. When combined with OpenClaw, you can create powerful automation workflows that leverage:

- **OpenClaw's persistent memory** for context retention
- **Claude Code's tool execution** for code manipulation
- **MCP integration** for seamless communication

## Available Subagent Types

Claude Code provides these built-in subagent types:

| Type | Purpose | Tools Available |
|------|---------|----------------|
| `general-purpose` | Complex multi-step tasks | All tools |
| `Explore` | Codebase exploration and search | Read-only tools |
| `Plan` | Implementation planning | Read-only tools |

## Using Subagents with OpenClaw

### Basic Subagent Invocation

```typescript
// Launch a subagent for research
const result = await agent.spawn({
  subagent_type: "Explore",
  prompt: "Find all files related to memory persistence in the codebase",
  description: "Search memory files"
});
```

### Connecting to OpenClaw via MCP

Configure Claude Code to use the OpenClaw MCP server for persistent context:

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "npx",
      "args": ["openclaw-mcp-server"],
      "env": {
        "OPENCLAW_GATEWAY_URL": "http://localhost:18789",
        "OPENCLAW_AGENT_ID": "main"
      }
    }
  }
}
```

### Memory-Aware Subagents

Subagents can access OpenClaw's memory system to maintain context across sessions:

```typescript
// Search memory before starting work
const context = await mcp.call("openclaw_memory_search", {
  query: "previous implementation decisions for auth system",
  mode: "vsearch"
});

// Store findings for future sessions
await mcp.call("openclaw_memory_add", {
  content: "Discovered auth uses JWT with RS256 signing",
  metadata: { topic: "auth", type: "finding" }
});
```

## Subagent Patterns

### Research-First Pattern

1. Launch an Explore subagent to understand the codebase
2. Store findings in OpenClaw memory
3. Use findings to inform implementation

```typescript
// Step 1: Research
const research = await spawn({
  subagent_type: "Explore",
  prompt: `Research how ${feature} is currently implemented.
           Check for existing patterns and conventions.`,
});

// Step 2: Store findings
await mcp.call("openclaw_memory_add", {
  content: research.summary,
  metadata: { phase: "research", feature }
});

// Step 3: Plan based on findings
const plan = await spawn({
  subagent_type: "Plan",
  prompt: `Based on the research, plan the implementation of ${newFeature}`
});
```

### Parallel Exploration Pattern

Launch multiple subagents concurrently for independent research:

```typescript
const [frontend, backend, tests] = await Promise.all([
  spawn({
    subagent_type: "Explore",
    prompt: "Find frontend components for user settings"
  }),
  spawn({
    subagent_type: "Explore",
    prompt: "Find backend API endpoints for settings"
  }),
  spawn({
    subagent_type: "Explore",
    prompt: "Find existing test patterns for settings"
  })
]);
```

### Context Injection Pattern

Pre-load relevant memory before subagent execution:

```typescript
// Fetch relevant context
const memories = await mcp.call("openclaw_memory_search", {
  query: taskDescription,
  limit: 5,
  mode: "vsearch"
});

// Include context in subagent prompt
const enrichedPrompt = `
Context from previous sessions:
${memories.map(m => m.content).join("\n---\n")}

Task: ${taskDescription}
`;

await spawn({
  subagent_type: "general-purpose",
  prompt: enrichedPrompt
});
```

## Configuration

### Subagent Settings

Configure subagent behavior in your OpenClaw config:

```json5
{
  agents: {
    defaults: {
      // Limit subagent depth to prevent runaway spawning
      maxSubagentDepth: 3,

      // Default thinking level for subagents
      subagentThinking: "low",

      // Timeout for subagent runs (seconds)
      subagentTimeout: 300
    }
  }
}
```

### Memory Integration Settings

```json5
{
  memory: {
    // Enable memory queries in subagents
    allowInSubagents: true,

    // QMD backend for vector search
    backend: "qmd",

    qmd: {
      // Use mcporter for faster queries
      mcporter: {
        enabled: true,
        serverName: "qmd"
      }
    }
  }
}
```

## Best Practices

### 1. Use Appropriate Subagent Types

- Use `Explore` for read-only research
- Use `Plan` for design decisions
- Use `general-purpose` only when modifications are needed

### 2. Persist Important Findings

Always store important discoveries in OpenClaw memory:

```typescript
// After any significant finding
await mcp.call("openclaw_memory_add", {
  content: finding,
  metadata: {
    timestamp: new Date().toISOString(),
    source: "subagent-exploration",
    confidence: "high"
  }
});
```

### 3. Limit Subagent Depth

Avoid deep subagent chains. Prefer parallel subagents:

```typescript
// Good: Parallel subagents
await Promise.all([
  spawn({ ... }),
  spawn({ ... })
]);

// Avoid: Deep nesting
// subagent1 -> subagent2 -> subagent3 -> ...
```

### 4. Clear Task Descriptions

Provide clear, specific prompts:

```typescript
// Good
spawn({
  prompt: "Find all React components that use the useAuth hook and list their file paths"
});

// Avoid
spawn({
  prompt: "Look at auth stuff"
});
```

## Troubleshooting

### Subagent Timeout

If subagents time out:
- Reduce the scope of the task
- Split into multiple smaller subagents
- Increase `subagentTimeout` in config

### Memory Not Found

If memory searches return empty:
- Verify the OpenClaw gateway is running
- Check the agent ID matches your config
- Ensure memories were stored with searchable content

### MCP Connection Issues

If MCP tools fail:
- Verify `OPENCLAW_GATEWAY_URL` is correct
- Check the gateway is running: `openclaw channels status --probe`
- Review gateway logs: `tail -f /tmp/openclaw-gateway.log`

---

_See also: [MCP Integration](/integrations/mcp), [Memory System](/concepts/memory)_
