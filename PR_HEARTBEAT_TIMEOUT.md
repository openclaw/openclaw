# PR: heartbeat.timeoutSeconds — per-heartbeat embedded run timeout

## Summary

Add `timeoutSeconds` config field to `agents.defaults.heartbeat` and `agents.list[].heartbeat` to allow heartbeat runs to fail fast when a model hangs, without affecting interactive agent turn timeouts.

## Motivation

**Real incident** (2026-03-15 ~11:02 EDT): Heartbeat configured with `openrouter/google/gemini-2.5-flash-lite` silently hung for 600s. The native model-fallback correctly recovered (flash-lite → opus), but only after the full timeout elapsed. A 60s heartbeat timeout would have triggered failover in 1/10th the time.

**Problem**: Heartbeat embedded runs inherit `agents.defaults.timeoutSeconds` (default 600s). When a heartbeat's model hangs (e.g., OpenRouter proxy silent timeout), the entire embedded run blocks for 10 minutes before failover kicks in.

Heartbeats are lightweight status checks — they should fail fast (30-60s), not consume a 10-minute timeout designed for complex interactive agent turns.

## Changes

### 1. Schema Updates

**File**: `src/config/zod-schema.agent-runtime.ts`

Added `timeoutSeconds` field to `HeartbeatSchema`:

```typescript
export const HeartbeatSchema = z.object({
  // ... existing fields ...
  timeoutSeconds: z.number().int().positive().optional(),
});
```

### 2. Type Definitions

**File**: `src/config/types.agent-defaults.ts`

Added `timeoutSeconds` to the heartbeat config type with documentation:

```typescript
heartbeat?: {
  // ... existing fields ...
  /**
   * Timeout for heartbeat embedded runs in seconds. Overrides agents.defaults.timeoutSeconds
   * for heartbeat runs only. Useful for failing fast when a heartbeat model hangs.
   * Default: inherits agents.defaults.timeoutSeconds (600s).
   * Example: 60 = fail over after 1 minute instead of 10 minutes.
   */
  timeoutSeconds?: number;
};
```

### 3. Runtime Integration

**File**: `src/infra/heartbeat-runner.ts`

Modified `runHeartbeatOnce` to read and pass the timeout override:

```typescript
const timeoutOverrideSeconds =
  typeof heartbeat?.timeoutSeconds === "number" ? heartbeat.timeoutSeconds : undefined;
const replyOpts = heartbeatModelOverride
  ? {
      isHeartbeat: true,
      heartbeatModelOverride,
      suppressToolErrorWarnings,
      bootstrapContextMode,
      timeoutOverrideSeconds,
    }
  : { isHeartbeat: true, suppressToolErrorWarnings, bootstrapContextMode, timeoutOverrideSeconds };
const replyResult = await getReplyFromConfig(ctx, replyOpts, cfg);
```

This threads through to `resolveAgentTimeoutMs` which already supports `timeoutOverrideSeconds`.

### 4. Tests

**File**: `src/infra/heartbeat-runner.timeout.test.ts`

Added unit tests covering:

- Basic timeoutSeconds config acceptance
- Per-agent override support
- Backward compatibility (undefined when not set)

All tests pass ✅

## Configuration Examples

### Global default for all heartbeats

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        timeoutSeconds: 60, // Fail fast after 1 minute
      },
    },
  },
}
```

### Per-agent override

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        timeoutSeconds: 60,
      },
    },
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          timeoutSeconds: 90, // Ops agent gets 90s timeout
        },
      },
    ],
  },
}
```

### Precedence

`agents.list[].heartbeat.timeoutSeconds` > `agents.defaults.heartbeat.timeoutSeconds` > `agents.defaults.timeoutSeconds` (existing 600s default)

## Impact

- **Affected users**: All users with heartbeat configured, especially those using third-party proxies (OpenRouter, etc.) prone to silent timeouts
- **Severity**: Medium — currently causes 10x slower failover when heartbeat models hang
- **Frequency**: Intermittent — triggered when proxy/model silently times out without error signal
- **Consequence**: Wasted time waiting for failover, delayed heartbeat recovery, potential cascading missed heartbeat cycles

## Backward Compatibility

✅ Fully backward compatible:

- Field is optional
- When not set, inherits existing behavior (uses `agents.defaults.timeoutSeconds`)
- No breaking changes to existing configs

## Testing

```bash
# Run new tests
pnpm test src/infra/heartbeat-runner.timeout.test.ts

# Expected output:
# ✓ src/infra/heartbeat-runner.timeout.test.ts (4 tests) 2ms
# Test Files 1 passed (1)
# Tests 4 passed (4)
```

## Related Issues

- Closes #47456

## Checklist

- [x] Schema updated with validation
- [x] Type definitions updated with documentation
- [x] Runtime integration complete
- [x] Tests added and passing
- [ ] Documentation updated (docs/cli/config.md or heartbeat-specific docs)
- [x] Backward compatible
- [ ] Changelog entry added

## Next Steps

1. Add documentation to `docs/agents/heartbeat.md` (if exists) or `docs/cli/config.md`
2. Add changelog entry
3. Submit PR and respond to reviews
