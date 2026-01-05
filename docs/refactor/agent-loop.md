---
summary: "Refactor plan: unify agent lifecycle events and wait semantics"
read_when:
  - Refactoring agent lifecycle events or wait behavior
---
# Refactor: Agent Loop

Goal: align Clawdis run lifecycle with pi/mom semantics, remove ambiguity between "job" and "agent_end".

## Problem
- Two lifecycles today:
  - `job` (gateway wrapper) => used by `agent.wait` + chat final
  - pi-agent `agent_end` (inner loop) => only logged
- This can finalize early (job done) while late assistant deltas still arrive.
- `afterMs` and timeouts can cause false timeouts in `agent.wait`.

## Reference (mom)
- Single lifecycle: `agent_start`/`agent_end` from pi-agent-core event stream.
- `waitForIdle()` resolves on `agent_end`.
- No separate job state exposed to clients.

## Proposed refactor (breaking allowed)
1) Replace public `job` stream with `lifecycle` stream
   - `stream: "lifecycle"`
   - `data: { phase: "start" | "end" | "error", startedAt, endedAt, error? }`
2) `agent.wait` waits on lifecycle end/error only
   - remove `afterMs`
   - return `{ runId, status, startedAt, endedAt, error? }`
3) Chat final emitted on lifecycle end only
   - deltas still from `assistant` stream
4) Centralize run registry
   - one map keyed by runId: sessionKey, startedAt, lastSeq, bufferedText
   - clear on lifecycle end

## Implementation outline
- `src/agents/pi-embedded-subscribe.ts`
  - emit lifecycle start/end events (translate pi `agent_start`/`agent_end`)
- `src/infra/agent-events.ts`
  - add `"lifecycle"` to stream type
- `src/gateway/protocol/schema.ts`
  - update AgentEvent schema; update AgentWait params (remove afterMs, add status)
- `src/gateway/server-methods/agent-job.ts`
  - rename to `agent-wait.ts` or similar; wait on lifecycle end/error
- `src/gateway/server-chat.ts`
  - finalize on lifecycle end (not job)
- `src/commands/agent.ts`
  - stop emitting `job` externally (keep internal log if needed)

## Migration notes (breaking)
- Update all callers of `agent.wait` to new response shape.
- Update tests that expect `timeout` based on job events.
- If any UI relies on job state, map lifecycle instead.

## Risks
- If lifecycle events are dropped, wait/chat could hang; add timeout in `agent.wait` to fail fast.
- Late deltas after lifecycle end should be ignored; keep seq tracking + drop.

## Acceptance
- One lifecycle visible to clients.
- `agent.wait` resolves when agent loop ends, not wrapper completion.
- Chat final never emits before last assistant delta.

## Rollout (if we wanted safety)
- Gate with config flag `agent.lifecycleMode = "legacy"|"refactor"`.
- Remove legacy after one release.
