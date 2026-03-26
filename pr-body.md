## Summary

Fixes #54936 - Subagent runTimeoutSeconds default fallback resolves to infinite timeout instead of configured default

When spawning a subagent via sessions_spawn without passing an explicit runTimeoutSeconds, the timeout resolved to 0, which was interpreted as "no timeout" (infinite). The configured default at `agents.defaults.subagents.runTimeoutSeconds` was never applied.

## Changes

- **src/agents/timeout.ts**: Add `forSubagent` option to `resolveAgentTimeoutSeconds` and `resolveAgentTimeoutMs` to check `agents.defaults.subagents.runTimeoutSeconds` first before falling back to main agent timeout
- **src/agents/subagent-spawn.ts**: Change fallback from `0` to `undefined` so the timeout resolver uses config defaults
- **src/agents/subagent-registry.ts**: Pass `forSubagent: true` to timeout resolution and change fallbacks to `undefined`
- **src/agents/subagent-depth.test.ts**: Add tests for subagent-specific timeout resolution

## Root Cause

The fallback chain resolved to `0` when no explicit timeout was passed:
```
params.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0
```

Then in `resolveAgentTimeoutMs`, `overrideSeconds: 0` was treated as "disable timeout" instead of "use config default".

## Testing

Added unit tests to verify:
- Subagent-specific config is used when `forSubagent: true`
- Falls back to main agent timeout when subagent config is not set
- Explicit `0` still disables timeout as intended
- Undefined uses the configured default

All existing tests pass.

## Impact

- Subagents spawned without explicit runTimeoutSeconds will now respect `agents.defaults.subagents.runTimeoutSeconds`
- Users who explicitly set `runTimeoutSeconds: 0` will still get no timeout (as intended)
- Backward compatible - explicit timeouts work as before