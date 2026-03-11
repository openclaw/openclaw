# Session-Level Circuit Breaker Design

**Issue:** #42864
**Date:** 2026-03-11

## Problem

Sessions accumulating bloated context trigger indefinite retry loops. The existing auth profile cooldown system handles transient provider failures but cannot detect when a session itself is structurally broken (e.g., context size exceeds model processing capacity). Heartbeat and cron jobs perpetuate stuck sessions indefinitely.

## Solution

A configurable session-level circuit breaker that tracks consecutive model errors per session and takes action (pause, reset, alert) when a threshold is reached.

## Configuration

Added to `AgentDefaultsConfig` and per-agent config:

```typescript
type CircuitBreakerAction = "pause" | "reset" | "alert";

type CircuitBreakerConfig = {
  consecutiveErrors?: number; // default 5
  action?: CircuitBreakerAction | CircuitBreakerAction[];
  alertChannel?: string;
  alertTo?: string;
  alertAccountId?: string;
  cooldownMinutes?: number; // default 30
};
```

Per-agent config overrides defaults (same pattern as `heartbeat`).

## SessionEntry State

New optional fields on `SessionEntry`:

- `cbErrorCount?: number` — consecutive model error count, reset on success
- `cbLastErrorAt?: number` — timestamp of last model error
- `cbLastErrorReason?: string` — reason of last model error
- `cbTrippedAt?: number` — timestamp when circuit breaker tripped
- `cbCooldownUntil?: number` — pause cooldown expiry timestamp

## Module Structure

```
src/agents/circuit-breaker/
  types.ts          — CircuitBreakerConfig type
  config.ts         — resolveCircuitBreakerConfig()
  state.ts          — pure functions: check/record/clear/execute
  state.test.ts     — unit tests
```

## Core API

- `isCircuitBreakerTripped(entry, config, now?)` — check if session is circuit-broken
- `recordCircuitBreakerError(entry, config, reason, now?)` — record error, return `{ tripped }`
- `clearCircuitBreakerErrors(entry)` — clear all cb state on success
- `executeCircuitBreakerActions(params)` — run configured actions

## State Machine

```
closed (normal)
  --[consecutive errors >= threshold]--> open (tripped)
    |-- action: alert --> send notification (no state change)
    |-- action: reset --> new session --> closed
    |-- action: pause --> set cooldownUntil
open + pause --[cooldown expired]--> half-open (probe)
    |-- success --> closed
    |-- failure --> open (re-trip, reset cooldown)
```

## Actions

- **alert**: Send notification via `deliverOutboundPayloads` to configured channel. Failure does not block other actions.
- **reset**: Generate new sessionId, clear transcript fields (equivalent to `/new`). Circuit breaker state naturally resets.
- **pause**: Set `cbCooldownUntil`. Subsequent runs skip until cooldown expires. `reset` takes priority over `pause` if both configured.

## Integration Points

Three callers, each adding ~10 lines:

1. `runHeartbeatOnce()` in `src/infra/heartbeat-runner.ts`
2. `runCronIsolatedAgentTurn()` in `src/cron/isolated-agent/run.ts`
3. `getReplyFromConfig()` in `src/auto-reply/reply/get-reply.ts`

Pattern: check tripped before run, record error/success after run, execute actions on trip.

## Error Scope

Only model-level errors count (FailoverError classifications: timeout, rate_limit, context overflow, auth, billing, overloaded, etc.). Tool execution errors and agent logic errors do not increment the counter.
