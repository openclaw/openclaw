# sessions_send_concurrent Tool

Concurrently send messages to multiple agent sessions with streaming responses and real-time progress updates. Behavior is **identical to `sessions_send`** for agent-to-agent communication (ping-pong and announce), with the added benefit of concurrent processing.

## Features

- **Concurrent execution**: Send messages to up to 20 target sessions simultaneously
- **Streaming responses**: Return results immediately as each agent completes, without waiting for all agents
- **Real-time progress**: Provide real-time progress updates via `onUpdate` callback
- **Flexible configuration**: Identify target sessions by sessionKey or label
- **Independent timeouts**: Set independent timeout for each target
- **Agent-to-Agent messaging**: Full support for A2A message context, ping-pong, and announce (same as `sessions_send`)
- **Error isolation**: Single target failure doesn't affect other targets
- **Complete permission control**: Inherits all permission checking mechanisms from `sessions_send`
- **Sandboxed mode**: Support for sandboxed mode, limiting access to sessions created by current agent

## Parameters

### targets (required)

Array of target sessions, containing 1-20 target objects.

Each target object contains:

- `sessionKey` (optional string): Target session's sessionKey
- `label` (optional string): Target session's label (1-64 characters)
- `agentId` (optional string): Target Agent ID (1-64 characters), used with label
- `message` (required string): Message content to send
- `timeoutSeconds` (optional number): Timeout for this target (seconds), defaults to global timeout

**Note**: `sessionKey` and `label` cannot both be provided, choose one.

### timeoutSeconds (optional number)

Global timeout in seconds, defaults to 30 seconds. If a target doesn't specify an independent timeout, this value is used.

Set to `0` for async send mode (fire-and-forget), returns immediately without waiting for response.

## Return Values

### Initial Progress Update

```json
{
  "runId": "uuid",
  "status": "started",
  "total": 3,
  "completed": 0
}
```

### Progress Update (when each agent completes)

```json
{
  "status": "progress",
  "total": 3,
  "completed": 1,
  "latestResult": {
    "sessionKey": "agent:coder:main",
    "displayKey": "agent:coder:main",
    "status": "ok",
    "reply": "Agent response",
    "runId": "uuid",
    "completedAt": 1234567890
  }
}
```

### Final Result

```json
{
  "runId": "uuid",
  "status": "completed",
  "total": 3,
  "completed": 3,
  "success": 2,
  "error": 1,
  "timeout": 0,
  "forbidden": 0,
  "results": [
    {
      "sessionKey": "agent:coder:main",
      "displayKey": "agent:coder:main",
      "status": "ok",
      "reply": "Agent response",
      "runId": "uuid",
      "completedAt": 1234567890
    },
    {
      "sessionKey": "agent:reviewer:main",
      "displayKey": "agent:reviewer:main",
      "status": "ok",
      "reply": "Another response",
      "runId": "uuid",
      "completedAt": 1234567891
    },
    {
      "sessionKey": "agent:tester:main",
      "displayKey": "agent:tester:main",
      "status": "error",
      "error": "Session not found",
      "runId": "uuid",
      "completedAt": 1234567892
    }
  ]
}
```

## Status Codes

- `ok`: Completed successfully
- `error`: Execution error
- `timeout`: Timeout
- `forbidden`: Permission denied (only returned in Sandboxed mode)
- `accepted`: Message accepted (only returned when `timeoutSeconds: 0`, indicates async execution)

## Concurrent Performance

### Concurrency Control

The tool uses Gateway's `CommandLane.Nested` channel for concurrency control:

- **Default concurrency**: Determined by `agents.defaults.maxConcurrent` config (default 16)
- **Maximum targets**: 20
- **Concurrent execution**: All targets execute simultaneously, not serially

### Performance Comparison

| Scenario         | Serial Execution | Concurrent Execution |
| ---------------- | ---------------- | -------------------- |
| 4 targets        | ~200s            | ~60s                 |
| 16 targets       | ~470s            | ~60s                 |
| Performance gain | -                | **3-8x**             |

### Configuring Concurrency

Configure in `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "maxConcurrent": 32
    }
  }
}
```

Restart Gateway after configuration:

```bash
openclaw gateway restart
```

## Usage Examples

### Example 1: Send same message to multiple sessions

```typescript
{
  "targets": [
    {
      "sessionKey": "agent:coder:main",
      "message": "Please check code quality"
    },
    {
      "sessionKey": "agent:reviewer:main",
      "message": "Please check code quality"
    }
  ],
  "timeoutSeconds": 60
}
```

### Example 2: Send message via label

```typescript
{
  "targets": [
    {
      "label": "coder",
      "agentId": "coder",
      "message": "Please implement new feature"
    },
    {
      "label": "reviewer",
      "agentId": "reviewer",
      "message": "Please review code"
    }
  ]
}
```

### Example 3: Mix sessionKey and label

```typescript
{
  "targets": [
    {
      "sessionKey": "agent:coder:main",
      "message": "Please fix bug"
    },
    {
      "label": "tester",
      "message": "Please run tests"
    }
  ]
}
```

### Example 4: Set independent timeout for each target

```typescript
{
  "targets": [
    {
      "sessionKey": "agent:fast:main",
      "message": "Quick query",
      "timeoutSeconds": 10
    },
    {
      "sessionKey": "agent:slow:main",
      "message": "Complex analysis",
      "timeoutSeconds": 120
    }
  ],
  "timeoutSeconds": 30
}
```

### Example 5: Async send mode (Fire-and-Forget)

```typescript
{
  "targets": [
    {
      "sessionKey": "agent:worker:main",
      "message": "Start background task",
      "timeoutSeconds": 0
    }
  ],
  "timeoutSeconds": 0
}
```

## Permission Control

The tool follows OpenClaw's permission control mechanism, fully consistent with `sessions_send`:

### Sandboxed Mode

When the tool runs in Sandboxed mode (via `sandboxed: true` option):

- **Restriction**: Can only access sessions created by the current agent
- **Error**: Returns `forbidden` status if attempting to access other sessions
- **Use case**: Limit agent access scope for security

### Agent-to-Agent Messaging

- **Configuration**: Requires `tools.agentToAgent.enabled=true`
- **Allow rules**: Configure corresponding allow rules to control which agents can communicate
- **Message context**: Automatically builds A2A message context including requester and target session info

### Session Visibility

Determine accessible sessions based on `tools.sessions.visibility` config:

- `all`: Can access all sessions
- `created`: Can only access sessions created by current agent (default for Sandboxed mode)

## Error Handling

### Error Isolation

- **Independent processing**: Errors from individual targets don't affect other targets
- **Complete results**: All targets return results regardless of success or failure
- **Error details**: Each failed target includes detailed error information

### Common Errors

| Error                                                   | Cause                                      | Solution                                                              |
| ------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `Session not found`                                     | Target session doesn't exist               | Check if sessionKey or label is correct                               |
| `Session not visible from this sandboxed agent session` | Accessing other sessions in Sandboxed mode | Use `sandboxed: false` or ensure session was created by current agent |
| `No session found with label`                           | Label resolution failed                    | Check if label and agentId are correct                                |
| `gateway timeout`                                       | Request timeout                            | Increase timeoutSeconds value                                         |

## Performance Considerations

1. **Concurrency limit**: Supports up to 20 targets to avoid overload
2. **Timeout handling**: Each target has independent timeout, doesn't affect others
3. **Error isolation**: Single target failure doesn't affect other targets
4. **Streaming updates**: Real-time progress feedback improves user experience
5. **Async mode**: Returns immediately when `timeoutSeconds: 0`, doesn't wait for response
6. **Concurrent execution**: Uses `CommandLane.Nested` channel, all targets execute truly concurrently
7. **A2A flow overhead**: Ping-pong and announce add ~2-5 seconds per target, but still 3-5x faster than serial `sessions_send`

## Agent-to-Agent Communication

### Behavior Consistency with sessions_send

The `sessions_send_concurrent` tool follows the **exact same behavior** as `sessions_send` for agent-to-agent communication:

- **Ping-pong**: Automatically enabled based on `session.agentToAgent.maxPingPongTurns` config
- **Announce step**: Always executes after primary run (unless agent replies `ANNOUNCE_SKIP`)
- **Fire-and-forget**: `timeoutSeconds: 0` triggers async A2A flow in background
- **No additional parameters needed**: Uses the same configuration as `sessions_send`

### Ping-Pong Configuration

Ping-pong is controlled by the **same configuration** as `sessions_send`:

```json
{
  "session": {
    "agentToAgent": {
      "maxPingPongTurns": 5
    }
  }
}
```

**Default**: 5 rounds (if not configured)

**No per-target override**: All targets use the same global config.

### When Ping-Pong Runs

Ping-pong runs **automatically** when ALL of these conditions are met:

1. ✅ `session.agentToAgent.maxPingPongTurns > 0` (from config)
2. ✅ `requesterSessionKey` exists (not `undefined`)
3. ✅ `requesterSessionKey !== targetSessionKey` (not self-to-self)

**Same as `sessions_send`**: These are the exact same conditions used by `sessions_send`.

### When Announce Runs

Announce step runs **automatically** after the primary run (and ping-pong, if enabled):

1. ✅ Primary run completed successfully
2. ✅ Reply content exists
3. ✅ Valid announce target exists
4. ✅ Agent did NOT reply `ANNOUNCE_SKIP`

**Same as `sessions_send`**: These are the exact same conditions used by `sessions_send`.

### Fire-and-Forget Mode

When `timeoutSeconds: 0`:

- Returns immediately with `status: "accepted"`
- A2A flow (ping-pong + announce) runs **asynchronously in background**
- Same behavior as `sessions_send`

### Result Format with Delivery Info

Each result includes a `delivery` field:

```json
{
  "sessionKey": "agent:coder:main",
  "displayKey": "agent:coder:main",
  "status": "ok",
  "reply": "Agent response",
  "runId": "uuid",
  "completedAt": 1234567890,
  "delivery": {
    "status": "pending",
    "mode": "announce"
  }
}
```

### Example: Default Behavior

```typescript
// Config
{
  "session": {
    "agentToAgent": {
      "maxPingPongTurns": 3
    }
  }
}

// Call
await sessions_send_concurrent({
  targets: [
    { sessionKey: "agent:coder:main", message: "Task 1" },
    { sessionKey: "agent:reviewer:main", message: "Task 2" }
  ],
  timeoutSeconds: 60
});

// Execution:
// ✅ Primary runs (concurrent)
// ✅ Ping-pong (3 rounds, concurrent)
// ✅ Announce steps (concurrent)
```

### Example: Fire-and-Forget

```typescript
await sessions_send_concurrent({
  targets: [
    { sessionKey: "agent:coder:main", message: "Task 1" },
    { sessionKey: "agent:reviewer:main", message: "Task 2" },
  ],
  timeoutSeconds: 0,
});

// Returns immediately with status: "accepted"
// A2A flows run asynchronously in background
```

### Example: Disable Ping-Pong

```typescript
// Config
{
  "session": {
    "agentToAgent": {
      "maxPingPongTurns": 0
    }
  }
}

// Call
await sessions_send_concurrent({
  targets: [
    { sessionKey: "agent:coder:main", message: "Task 1" }
  ],
  timeoutSeconds: 60
});

// Execution:
// ✅ Primary run
// ❌ No ping-pong (disabled by config)
// ✅ Announce step
```

## Comparison with sessions_send

| Feature              | sessions_send                           | sessions_send_concurrent            |
| -------------------- | --------------------------------------- | ----------------------------------- |
| Target count         | 1                                       | 1-20                                |
| Response mode        | Wait for completion                     | Streaming, return as each completes |
| Independent timeout  | Not supported                           | Supported                           |
| Progress feedback    | None                                    | Real-time progress updates          |
| Concurrent execution | Not supported                           | Supported (uses CommandLane.Nested) |
| Ping-pong control    | `session.agentToAgent.maxPingPongTurns` | Same config                         |
| Announce step        | Always runs (unless skipped)            | Always runs (unless skipped)        |
| Fire-and-forget      | `timeoutSeconds: 0`                     | Same behavior                       |
| Use case             | Single interaction, multi-turn          | Batch tasks, parallel processing    |

## Best Practices

### 1. Set reasonable timeouts

```typescript
// ✅ Good: Set timeout based on task complexity
{
  "targets": [
    {
      "sessionKey": "agent:quick:main",
      "message": "Simple query",
      "timeoutSeconds": 10
    },
    {
      "sessionKey": "agent:complex:main",
      "message": "Complex analysis",
      "timeoutSeconds": 300
    }
  ]
}

// ❌ Bad: All targets use same timeout
{
  "targets": [
    {
      "sessionKey": "agent:quick:main",
      "message": "Simple query",
      "timeoutSeconds": 300  // Too long
    },
    {
      "sessionKey": "agent:complex:main",
      "message": "Complex analysis",
      "timeoutSeconds": 10  // Too short
    }
  ]
}
```

### 2. Handle errors

```typescript
// Check status of each target
const result = await sessions_send_concurrent({ targets });

result.results.forEach((r) => {
  if (r.status === "ok") {
    console.log(`${r.displayKey}: ${r.reply}`);
  } else if (r.status === "error") {
    console.error(`${r.displayKey}: ${r.error}`);
  } else if (r.status === "timeout") {
    console.warn(`${r.displayKey}: Timeout`);
  } else if (r.status === "forbidden") {
    console.warn(`${r.displayKey}: Permission denied`);
  }
});
```

### 3. Use streaming progress

```typescript
// Get real-time progress via onUpdate callback
const result = await sessions_send_concurrent({
  targets,
  stream: true,
  onProgress: (progress) => {
    console.log(`Progress: ${progress.completed}/${progress.total}`);
    if (progress.latestResult) {
      console.log(
        `Latest result: ${progress.latestResult.displayKey} - ${progress.latestResult.status}`,
      );
    }
  },
});
```

### 4. Concurrent performance optimization

```typescript
// ✅ Good: Leverage concurrent capabilities
const result = await sessions_send_concurrent({
  targets: [
    { sessionKey: "agent:1:main", message: "Task 1" },
    { sessionKey: "agent:2:main", message: "Task 2" },
    { sessionKey: "agent:3:main", message: "Task 3" },
    { sessionKey: "agent:4:main", message: "Task 4" },
  ],
  timeoutSeconds: 60,
});
// Expected: ~60s completion (concurrent execution)

// ❌ Bad: Serial calls to sessions_send
for (const target of targets) {
  await sessions_send({ sessionKey: target.sessionKey, message: target.message });
}
// Expected: ~240s completion (serial execution)
```

## Notes

1. **Label conflicts**: When using label, if multiple matching sessions exist, system selects the first one
2. **Timeout settings**: Set reasonable timeout based on task complexity
3. **Error handling**: Check status field of each target in results array to determine execution result
4. **Resource usage**: Concurrent calls consume more resources, adjust target count based on system performance
5. **Ping-pong behavior**: Automatically enabled based on `session.agentToAgent.maxPingPongTurns` config (same as `sessions_send`)
6. **Announce behavior**: Always runs after primary run unless agent replies `ANNOUNCE_SKIP` (same as `sessions_send`)
7. **Sandboxed mode**: In Sandboxed mode, can only access sessions created by current agent
8. **Concurrency configuration**: Ensure `agents.defaults.maxConcurrent` is configured high enough to support required concurrency
9. **A2A flow**: Ping-pong and announce run asynchronously after tool returns, check `delivery` field for status

## Related Tools

- `sessions_send`: Send message to single session
- `sessions_list`: List available sessions
- `sessions_resolve`: Resolve label to sessionKey
- `sessions_spawn`: Create new sub-agent session

## Configuration

### Agent-to-Agent Messaging Configuration

```json
{
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allow": [
        {
          "from": "*",
          "to": "*"
        }
      ]
    },
    "sessions": {
      "visibility": "all"
    }
  }
}
```

### Concurrency Configuration

```json
{
  "agents": {
    "defaults": {
      "maxConcurrent": 16
    }
  }
}
```

## Technical Implementation

### Concurrency Mechanism

The tool uses `CommandLane.Nested` channel for true concurrent execution:

1. **Gateway server-side task queue**: Each lane has independent queue and concurrency control
2. **Concurrency controlled by `maxConcurrent`**: Can be adjusted via configuration
3. **All targets execute simultaneously**: Not serial waiting, but true concurrency

### Streaming Updates

The tool provides real-time progress via `onUpdate` callback:

1. **Initial update**: Send notification when task starts
2. **Progress update**: Send update as each target completes
3. **Final update**: Send final result after all targets complete

### Error Isolation Implementation

The tool uses `Promise.allSettled` to ensure all requests complete:

1. **Complete results**: All targets return results
2. **Error isolation**: Single target failure doesn't affect other targets
3. **Detailed errors**: Each failed target includes error information

---

**Documentation Version**: 2.0  
**Last Updated**: 2026-03-05  
**Tool Version**: OpenClaw 2026.3.3+
