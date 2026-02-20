## Problem

Heartbeat polls were firing every few seconds instead of the configured interval (e.g., 30 minutes). This was reported in issue #14440.

## Root Cause

In `src/infra/heartbeat-runner.ts`, the interval check was:

```typescript
if (isInterval && now < agent.nextDueMs) {
```

This only enforced the interval when the trigger reason was `"interval"` (timer-based). When triggered by other events like exec completions, cron wakes, or subagent completions, `isInterval` was `false`, causing the check to be bypassed entirely.

## Fix

Remove the `isInterval &&` condition so the interval is always enforced:

```typescript
if (now < agent.nextDueMs) {
```

This ensures the heartbeat only fires when the configured interval has elapsed, regardless of what triggers the check.

## Testing

After applying this fix:

- `every: "30m"` config is now respected
- Exec completions no longer bypass the interval
- Heartbeats fire at the configured interval, not on every activity event

Fixes #14440
