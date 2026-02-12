---
summary: "Control nested sub-agent spawning depth and concurrent execution"
title: Nested Sub-Agents Configuration
read_when: "You need to control how deep sub-agents can spawn other sub-agents and manage concurrent execution"
status: active
---

# Nested Sub-Agents Configuration

## Overview

This feature allows fine-grained control over sub-agent spawning behavior, including maximum nesting depth and concurrent execution limits. It prevents infinite recursion in complex agent workflows while allowing reasonable delegation of tasks.

## Feature Status

- **Added**: 2026-02-12
- **Version**: OpenClaw 2026.2.12+
- **Status**: Active

## Configuration

### Schema Changes

Added `maxSpawnDepth` field to `subagents` schema in `src/config/zod-schema.agent-defaults.ts`:

```typescript
export const AgentDefaultsSchema = z
  .object({
    // ... other fields
    subagents: z
      .object({
        maxConcurrent: z.number().int().positive().optional(),
        /** Maximum depth of nested sub-agents (default: 2) */
        maxSpawnDepth: z.number().int().min(1).max(10).optional(),
        archiveAfterMinutes: z.number().int().positive().optional(),
        model: z
          .union([
            z.string(),
            z
              .object({
                primary: z.string().optional(),
                fallbacks: z.array(z.string()).optional(),
              })
              .strict(),
          ])
          .optional(),
        thinking: z.string().optional(),
      })
      .strict()
      .optional(),
    // ... other fields
  })
  .strict()
  .optional();
```

### Type Definition

Added `maxSpawnDepth` field to `AgentDefaultsConfig.subagents` in `src/config/types.agent-defaults.ts`:

```typescript
export type AgentDefaultsConfig = {
  // ... other fields
  subagents?: {
    /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 1. */
    maxConcurrent?: number;
    /** Maximum depth of nested sub-agents (default: 2) */
    maxSpawnDepth?: number;
    /** Auto-archive sub-agent sessions after N minutes (default: 60). */
    archiveAfterMinutes?: number;
    /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
    /** Default thinking level for spawned sub-agents (e.g. "off", "low", "medium", "high"). */
    thinking?: string;
  };
  // ... other fields
};
```

## Usage

### Configuration Example

In `~/.openclaw/openclaw.json`:

```json
{
  "agentDefaults": {
    "subagents": {
      "maxSpawnDepth": 3,
      "maxConcurrent": 2,
      "archiveAfterMinutes": 120,
      "model": {
        "primary": "anthropic/claude-sonnet-4-5",
        "fallbacks": ["openai/gpt-4.5", "openai/gpt-4"]
      },
      "thinking": "low"
    }
  }
}
```

### Default Values

- **maxSpawnDepth**: 2 (maximum 10)
- **maxConcurrent**: 1 (global "subagent" lane)
- **archiveAfterMinutes**: 60
- **model**: Inherits from parent agent's model configuration
- **thinking**: Inherits from parent agent's thinkingDefault

## Use Cases

### 1. Complex Task Delegation

When an agent needs to break down a complex task into sub-tasks that may themselves require further delegation:

```
Main Agent (Depth 0)
  ├── Sub-agent A (Depth 1) - Research phase
  │      ├── Sub-agent A1 (Depth 2) - Technical research
  │      └── Sub-agent A2 (Depth 2) - Market research
  └── Sub-agent B (Depth 1) - Implementation phase
         ├── Sub-agent B1 (Depth 2) - Backend implementation
         └── Sub-agent B2 (Depth 2) - Frontend implementation
```

### 2. Multi-Stage Workflows

Sequential workflows where each stage may need specialized sub-agents:

```
Main Agent (Planning)
  └── Sub-agent 1 (Design)
        └── Sub-agent 1.1 (UI Design)
              └── Sub-agent 1.1.1 (Accessibility Review)
```

### 3. Recursive Problem Solving

Problems that benefit from recursive decomposition:

```
Main Agent (Problem Analysis)
  └── Sub-agent (Divide Problem)
        ├── Sub-agent A (Solve Sub-problem A)
        └── Sub-agent B (Solve Sub-problem B)
              └── Sub-agent B.1 (Further decompose)
```

## Best Practices

### 1. Depth vs. Complexity

- **Shallow depth (1-2)**: For simple task delegation
- **Medium depth (3-4)**: For complex workflows with multiple phases
- **Deep depth (5+)**: Rare, use only for highly recursive problems

### 2. Combined with Timeout Configuration

When using deep sub-agent hierarchies, consider increasing provider timeout:

```json
{
  "agentDefaults": {
    "subagents": {
      "maxSpawnDepth": 4
    }
  },
  "models": {
    "providers": {
      "anthropic": {
        "timeoutMs": 900000
      }
    }
  }
}
```

### 3. Resource Management

Monitor system resources when using high `maxConcurrent` values:

```json
{
  "agentDefaults": {
    "maxConcurrent": 3,
    "subagents": {
      "maxConcurrent": 2,
      "maxSpawnDepth": 3
    }
  }
}
```

## Implementation Details

### Depth Tracking

Each spawned sub-agent tracks its depth relative to the root agent:

- **Depth 0**: Root (main) agent
- **Depth 1**: Direct sub-agents spawned by root
- **Depth 2**: Sub-sub-agents spawned by depth 1 agents
- And so on, up to `maxSpawnDepth`

### Error Handling

- **Depth limit exceeded**: Attempts to spawn beyond `maxSpawnDepth` are rejected with a clear error
- **Concurrent limit exceeded**: Additional spawns wait in queue when `maxConcurrent` is reached

### Session Management

- Each sub-agent gets its own session with appropriate depth metadata
- Sessions are automatically archived after `archiveAfterMinutes`
- Parent-child relationships are tracked for debugging and monitoring

## Testing

To verify sub-agent depth limits are working:

```bash
# 1. Configure maxSpawnDepth in your configuration
# 2. Restart OpenClaw Gateway
openclaw gateway restart

# 3. Test with a deep nesting script
#    (Example: create a script that attempts to spawn multiple levels)
# 4. Check for depth limit errors in logs
tail -f ~/.openclaw/logs/gateway.log | grep -i "depth\|spawn"
```

## Common Patterns

### Pattern 1: Hierarchical Delegation

```json
{
  "agentDefaults": {
    "subagents": {
      "maxSpawnDepth": 3,
      "maxConcurrent": 3
    }
  }
}
```

Use when tasks naturally decompose into 2-3 levels of specialization.

### Pattern 2: Flat Parallel Processing

```json
{
  "agentDefaults": {
    "subagents": {
      "maxSpawnDepth": 1,
      "maxConcurrent": 5
    }
  }
}
```

Use when you need many parallel sub-tasks but no further nesting.

### Pattern 3: Controlled Recursion

```json
{
  "agentDefaults": {
    "subagents": {
      "maxSpawnDepth": 4,
      "maxConcurrent": 2,
      "archiveAfterMinutes": 30
    }
  }
}
```

Use for recursive problem solving with tight resource constraints.

## Troubleshooting

### Issue: "Maximum spawn depth exceeded" Error

**Symptoms**: Sub-agent spawning fails with depth limit error

**Solutions**:

- Increase `maxSpawnDepth` if deeper nesting is genuinely needed
- Redesign workflow to use shallower hierarchy
- Use parallel processing instead of deep nesting

### Issue: Sub-agents Not Starting

**Possible Causes**:

1. `maxConcurrent` limit reached
2. System resource constraints
3. Model provider timeout too low

**Solutions**:

- Increase `maxConcurrent` if resources allow
- Check system resources (CPU, memory)
- Increase provider timeout (see [Timeout Configuration](/concepts/timeout-config))

### Issue: Sub-agent Sessions Not Archiving

**Solutions**:

- Ensure `archiveAfterMinutes` is set (default: 60)
- Check session archiving is enabled in gateway config
- Monitor session lifecycle in logs

## Integration with Other Features

### With Model Provider Timeouts

Deep sub-agent workflows often require longer timeouts:

```json
{
  "agentDefaults": {
    "subagents": {
      "maxSpawnDepth": 4
    }
  },
  "models": {
    "providers": {
      "anthropic": {
        "timeoutMs": 1200000
      }
    }
  }
}
```

### With Sandboxing

For enhanced security with nested sub-agents:

```json
{
  "agentDefaults": {
    "subagents": {
      "maxSpawnDepth": 3
    },
    "sandbox": {
      "mode": "all",
      "scope": "session"
    }
  }
}
```

## Related Documentation

- [Model Provider Timeout Configuration](/concepts/timeout-config)
- [Multi-Agent Routing](/concepts/multi-agent)
- [Agent Workspace](/concepts/agent-workspace)
- [Session Management](/concepts/sessions)

---

**Last Updated**: 2026-02-12
