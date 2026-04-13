# Tool Call Hooks

This document describes the `before_tool_call` and `after_tool_call` plugin hooks that enable observation and control of tool execution.

## Overview

Tool call hooks allow plugins to:

- Observe tool invocations and their results
- Modify tool parameters before execution
- Block (veto) tool execution based on security policies or other criteria
- Track tool execution timing and errors

## Hook Lifecycle

```
Agent requests tool execution
         |
         v
  before_tool_call hook
         |
    +----+----+
    |         |
  block    allow
    |         |
    v         v
 (skip)    Execute tool
    |         |
    +----+----+
         |
         v
  after_tool_call hook
```

## before_tool_call Hook

Fired immediately before a tool executes. Handlers can modify parameters or block execution.

### Event Payload

```typescript
type PluginHookBeforeToolCallEvent = {
  toolName: string; // Normalized tool name (lowercase)
  params: Record<string, unknown>; // Tool input parameters
};
```

### Context

```typescript
type PluginHookToolContext = {
  agentId?: string; // Agent identifier
  sessionKey?: string; // Session identifier for correlation
  toolName: string; // Same as event.toolName
};
```

### Result (Veto Contract)

```typescript
type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>; // Modified params (merged with original)
  block?: boolean; // If true, block tool execution
  blockReason?: string; // Human-readable reason for blocking
};
```

### Example: Logging Handler

```typescript
api.on("before_tool_call", async (event, ctx) => {
  console.log(`[${ctx.sessionKey}] Tool: ${event.toolName}`);
  console.log(`  Params: ${JSON.stringify(event.params)}`);
  // Return nothing to allow execution with original params
});
```

### Example: Parameter Modification

```typescript
api.on("before_tool_call", async (event, ctx) => {
  if (event.toolName === "read") {
    // Prefix all file paths with sandbox directory
    const path = event.params.path as string;
    if (path && !path.startsWith("/sandbox/")) {
      return {
        params: { ...event.params, path: `/sandbox${path}` },
      };
    }
  }
});
```

### Example: Security Veto

```typescript
api.on("before_tool_call", async (event, ctx) => {
  if (event.toolName === "exec" || event.toolName === "bash") {
    const command = event.params.command as string;

    // Block dangerous commands
    const dangerous = ["rm -rf", "sudo", "chmod 777", "> /etc/"];
    for (const pattern of dangerous) {
      if (command.includes(pattern)) {
        return {
          block: true,
          blockReason: `Blocked: command contains dangerous pattern '${pattern}'`,
        };
      }
    }
  }
});
```

## after_tool_call Hook

Fired after tool execution completes (success, error, or blocked).

### after_tool_call Event

```typescript
type PluginHookAfterToolCallEvent = {
  toolName: string; // Normalized tool name
  params: Record<string, unknown>; // Tool input parameters (as executed)
  result?: unknown; // Tool output (if successful)
  error?: string; // Error message (if failed)
  durationMs?: number; // Execution time in milliseconds
  blocked?: boolean; // True if blocked by before_tool_call
  blockReason?: string; // Reason if blocked
};
```

### after_tool_call Context

Same as `before_tool_call`.

### Example: Metrics Collection

```typescript
const toolMetrics = new Map<string, { count: number; totalMs: number }>();

api.on("after_tool_call", async (event, ctx) => {
  const metrics = toolMetrics.get(event.toolName) || { count: 0, totalMs: 0 };
  metrics.count += 1;
  metrics.totalMs += event.durationMs || 0;
  toolMetrics.set(event.toolName, metrics);

  if (event.error) {
    console.error(`Tool ${event.toolName} failed: ${event.error}`);
  }
});
```

### Example: Audit Logging

```typescript
api.on("after_tool_call", async (event, ctx) => {
  await auditLog.write({
    timestamp: Date.now(),
    session: ctx.sessionKey,
    tool: event.toolName,
    params: event.params,
    success: !event.error,
    error: event.error,
    durationMs: event.durationMs,
  });
});
```

## Veto Contract Details

### How Blocking Works

1. Plugin registers `before_tool_call` handler
2. Handler returns `{ block: true, blockReason: "..." }`
3. Tool execution is skipped
4. Agent receives error result:

```json
{
  "status": "error",
  "tool": "exec",
  "error": "Blocked: command contains dangerous pattern 'rm -rf'"
}
```

5. `after_tool_call` fires with error reflecting the block

### Multiple Handlers

When multiple plugins register `before_tool_call` handlers:

1. Handlers execute sequentially in priority order (higher priority first)
2. If ANY handler returns `block: true`, execution is blocked
3. Parameter modifications are merged across handlers
4. The first `blockReason` encountered is used

```typescript
// Plugin A (priority: 100)
api.on("before_tool_call", handler, { priority: 100 });

// Plugin B (priority: 50) - runs after A
api.on("before_tool_call", handler, { priority: 50 });
```

### Error Handling

If a `before_tool_call` handler throws an error:

- The error is logged
- By default, execution continues (fail-open)
- Set `catchErrors: false` in hook runner options for fail-closed behavior

## Event Payload Examples

### before_tool_call: File Read

```json
{
  "toolName": "read",
  "params": {
    "path": "/home/user/document.txt",
    "offset": 0,
    "limit": 100
  }
}
```

Context:

```json
{
  "agentId": "main",
  "sessionKey": "sess_abc123",
  "toolName": "read"
}
```

### before_tool_call: Shell Command

```json
{
  "toolName": "bash",
  "params": {
    "command": "ls -la /workspace",
    "timeout": 30000
  }
}
```

### after_tool_call: Success

```json
{
  "toolName": "read",
  "params": {
    "path": "/home/user/document.txt"
  },
  "result": {
    "content": [{ "type": "text", "text": "File contents here..." }]
  },
  "durationMs": 12
}
```

### after_tool_call: Error

```json
{
  "toolName": "read",
  "params": {
    "path": "/nonexistent/file.txt"
  },
  "error": "ENOENT: no such file or directory",
  "durationMs": 3
}
```

### after_tool_call: Blocked

```json
{
  "toolName": "exec",
  "params": {
    "command": "rm -rf /"
  },
  "error": "Blocked: command contains dangerous pattern 'rm -rf'",
  "durationMs": 0
}
```

## Full Plugin Example

```typescript
import { definePlugin } from "openclaw/plugins";

export default definePlugin({
  id: "tool-guard",
  name: "Tool Guard",
  description: "Security guardrails for tool execution",

  activate(api) {
    const blockedPatterns = ["rm -rf", "sudo", "> /etc/", "chmod 777"];

    // Before tool call: veto dangerous commands
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (event.toolName !== "exec" && event.toolName !== "bash") {
          return; // Only guard shell commands
        }

        const command = String(event.params.command || "");

        for (const pattern of blockedPatterns) {
          if (command.includes(pattern)) {
            api.logger.warn(
              `Blocked ${event.toolName}: ${pattern} detected in session ${ctx.sessionKey}`,
            );
            return {
              block: true,
              blockReason: `Security policy: '${pattern}' not allowed`,
            };
          }
        }
      },
      { priority: 1000 },
    ); // High priority: run first

    // After tool call: audit log
    api.on("after_tool_call", async (event, ctx) => {
      api.logger.info(
        `Tool ${event.toolName} completed in ${event.durationMs}ms ` +
          `(session: ${ctx.sessionKey}, success: ${!event.error})`,
      );
    });
  },
});
```

## Best Practices

### 1. Keep Handlers Fast

`before_tool_call` runs synchronously in the tool execution path. Long-running handlers delay tool execution.

```typescript
// Good: Quick check
api.on("before_tool_call", async (event) => {
  if (blocklist.has(event.toolName)) {
    return { block: true, blockReason: "Tool not allowed" };
  }
});

// Bad: Slow API call
api.on("before_tool_call", async (event) => {
  const allowed = await slowApiCheck(event); // Don't do this
  if (!allowed) return { block: true };
});
```

### 2. Use Priority for Ordering

Security handlers should run first (higher priority):

```typescript
api.on("before_tool_call", securityHandler, { priority: 1000 });
api.on("before_tool_call", loggingHandler, { priority: 100 });
api.on("before_tool_call", metricsHandler, { priority: 10 });
```

### 3. Handle Errors Gracefully

Handlers should not throw. Catch and log errors:

```typescript
api.on("after_tool_call", async (event, ctx) => {
  try {
    await sendToMetricsService(event);
  } catch (err) {
    api.logger.error(`Metrics failed: ${err}`);
    // Don't re-throw
  }
});
```

### 4. Provide Clear Block Reasons

Help users understand why tools were blocked:

```typescript
// Good
return {
  block: true,
  blockReason: "File /etc/passwd is protected. Use /workspace for file operations.",
};

// Bad
return { block: true, blockReason: "blocked" };
```

## Related Hooks

- `tool_result_persist`: Modify tool results before session storage
- `before_message_write`: Control what gets written to session transcripts
- `llm_input` / `llm_output`: Observe LLM interactions
