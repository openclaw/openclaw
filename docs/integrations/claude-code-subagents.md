---
title: Claude Code Subagents
description: Using Claude Code subagents with OpenClaw for autonomous task execution
---

# Claude Code Subagents with OpenClaw

OpenClaw integrates with Claude Code subagents to enable autonomous task execution,
persistent memory workflows, and coordinated multi-agent operations.

## Overview

Claude Code subagents are specialized agents that can be spawned to handle complex,
multi-step tasks autonomously. When integrated with OpenClaw, these subagents gain
access to:

- Persistent memory across sessions
- Browser automation capabilities
- Multi-channel communication
- Skill execution and workspace management

## Subagent Types

### Research Agents

Use the `Explore` subagent type for codebase exploration:

```typescript
// Claude Code will spawn an Explore agent for:
// - Finding files by patterns
// - Searching code for keywords
// - Understanding codebase architecture
```

### Planning Agents

Use the `Plan` subagent type for architectural decisions:

```typescript
// Plan agents help with:
// - Implementation strategy design
// - Identifying critical files
// - Evaluating trade-offs
```

### General Purpose Agents

Default agents handle multi-step tasks:

```typescript
// General agents can:
// - Execute complex workflows
// - Coordinate across tools
// - Maintain context through tasks
```

## Integration with OpenClaw

### Enabling Subagent Support

Configure subagents in your OpenClaw config:

```json5
{
  "agents": {
    "list": [
      {
        "id": "main",
        "subagents": {
          "enabled": true,
          "maxConcurrent": 3,
          "defaultModel": "claude-sonnet-4-6",
          "memorySharing": true
        }
      }
    ]
  }
}
```

### Memory Sharing

Subagents can share memory with the parent agent:

```json5
{
  "subagents": {
    "memorySharing": true,
    "memoryScope": "session" // or "persistent"
  }
}
```

### Workspace Isolation

Control workspace access for subagents:

```json5
{
  "subagents": {
    "sandbox": {
      "enabled": true,
      "readOnly": ["config/", "secrets/"],
      "writeAllow": ["output/", "temp/"]
    }
  }
}
```

## Subagent Communication Patterns

### Message Passing

Subagents communicate through the OpenClaw message bus:

```typescript
// Parent agent sends task to subagent
await openclaw.message.send({
  to: "subagent:research",
  content: "Find all API endpoints in the codebase",
  context: { workspace: "/project" }
});

// Subagent responds with results
// Results are automatically persisted to memory
```

### Event Broadcasting

Subagents can broadcast events:

```typescript
// Subagent broadcasts progress
openclaw.events.emit("subagent:progress", {
  taskId: "task-123",
  progress: 0.75,
  status: "Analyzing files..."
});
```

## Best Practices

### 1. Use Appropriate Agent Types

Match the agent type to the task:

| Task Type | Recommended Agent |
|-----------|------------------|
| File search | `Explore` |
| Code analysis | `Explore` |
| Implementation planning | `Plan` |
| Multi-step execution | `general-purpose` |
| Documentation lookup | `claude-code-guide` |

### 2. Manage Concurrency

Limit concurrent subagents to prevent resource exhaustion:

```json5
{
  "subagents": {
    "maxConcurrent": 3,
    "queueOverflow": "reject" // or "wait"
  }
}
```

### 3. Handle Failures Gracefully

Configure retry and fallback behavior:

```json5
{
  "subagents": {
    "retry": {
      "maxAttempts": 3,
      "backoffMs": 1000
    },
    "onFailure": "report" // or "escalate"
  }
}
```

### 4. Use Background Execution

Run independent tasks in the background:

```typescript
// Launch agent in background
const agentId = await openclaw.subagent.spawn({
  type: "research",
  prompt: "Analyze dependency tree",
  background: true
});

// Continue with other work
// You'll be notified when complete
```

## Example Workflows

### Code Review Workflow

```typescript
// 1. Spawn research agent to understand changes
const research = await openclaw.subagent.spawn({
  type: "Explore",
  prompt: "Analyze the changes in the current PR"
});

// 2. Use planning agent for review strategy
const plan = await openclaw.subagent.spawn({
  type: "Plan",
  prompt: "Create a review checklist based on the changes"
});

// 3. Execute review with general agent
const review = await openclaw.subagent.spawn({
  type: "general-purpose",
  prompt: "Review code based on checklist, suggest improvements"
});
```

### Documentation Generation

```typescript
// 1. Explore codebase structure
const explore = await openclaw.subagent.spawn({
  type: "Explore",
  prompt: "Map all public APIs and their purposes"
});

// 2. Generate documentation
const docs = await openclaw.subagent.spawn({
  type: "general-purpose",
  prompt: "Generate API documentation from the analysis",
  memoryContext: explore.results
});
```

## Monitoring and Debugging

### View Subagent Status

```bash
openclaw agent status --subagents
```

### Access Subagent Logs

```bash
openclaw logs --agent subagent:research --tail 100
```

### Debug Mode

Enable verbose logging for subagents:

```json5
{
  "subagents": {
    "debug": true,
    "logLevel": "verbose"
  }
}
```

## Related Documentation

- [Multi-Agent Architecture](/concepts/multi-agent)
- [Memory System](/concepts/memory)
- [Agent Workspace](/concepts/agent-workspace)
- [MCP Integration](/integrations/mcp)
