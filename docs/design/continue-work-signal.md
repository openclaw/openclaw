# RFC: Agent Self-Elected Turn Continuation (`CONTINUE_WORK`)

## Problem

When an agent completes a turn (processes a message, heartbeat, or sub-agent result), it becomes inert until the next external event. There is no mechanism for an agent to signal "I have more work to do — give me another turn."

This leads to the **dwindle pattern**: agents with active work queues go idle between external events, losing momentum and context continuity.

## Proposed Solution

Add a new response token `CONTINUE_WORK` (alongside existing `NO_REPLY` and `HEARTBEAT_OK`) that signals the gateway to schedule another turn for the same session after a configurable delay.

### Token Variants

```
CONTINUE_WORK              → schedule another turn (same session, default delay)
CONTINUE_WORK:30           → schedule another turn after 30 seconds
[[CONTINUE_DELEGATE: <task>]]   → spawn sub-agent with task, result wakes parent
DONE                       → (default) session goes inert until external event
```

### Gateway Behavior

1. After agent response is finalized, the gateway checks for continuation signals
2. If `CONTINUE_WORK` is detected (with optional delay):
   - Strip the token from the displayed response (like `NO_REPLY`)
   - Schedule an internal "continuation" event for the session after `delay` ms
   - The continuation event delivers a system message like: `[continuation:wake] Turn N/M. You elected to continue. Resume your work.`
3. If `[[CONTINUE_DELEGATE: <task>]]` is detected:
   - Strip the token
   - Spawn a sub-agent with the specified task
   - Sub-agent completion naturally wakes the parent session
4. If neither token is present, normal behavior (inert until external event)

### Safety Constraints

- **Max continuation chain**: configurable limit (default: 10) to prevent runaway loops
- **Cost cap**: optional per-session token budget for self-elected turns
- **Interruptibility**: external events (direct mentions, operator messages) always preempt scheduled continuations
- **Cooldown**: minimum delay between continuations (default: 5s) to prevent tight loops
- **Observability**: continuation chains logged in session history; operator can view/kill active chains
- **Opt-in**: disabled by default; enabled via `agents.defaults.continuation.enabled: true`

### Configuration

```yaml
# In openclaw config
agents:
  defaults:
    continuation:
      enabled: false # opt-in per deployment
      maxChainLength: 10 # max consecutive self-elected turns
      defaultDelayMs: 15000 # default delay between continuations
      minDelayMs: 5000 # minimum allowed delay
      maxDelayMs: 300000 # maximum allowed delay (5 min)
      costCapTokens: 500000 # max tokens per chain (0 = unlimited)
```

> **Note on DELEGATE chains:** `CONTINUE_DELEGATE` spawns sub-agents whose
> completion announcements reset the parent's chain state (they are external
> messages, not continuation events). Delegation loops are bounded by
> `agents.defaults.subagents.maxChildrenPerAgent` (default: 5) and
> `maxSpawnDepth` (default: 1), not by `maxChainLength`.

## Implementation Notes

### Where to Hook

1. **Token parsing**: `src/auto-reply/tokens.ts` — add `CONTINUE_WORK_TOKEN` alongside existing tokens
2. **Detection**: `src/auto-reply/reply/agent-runner.ts` — detect continuation signal in final assembled payloads (not streaming partials)
3. **Scheduling**: `src/auto-reply/reply/get-reply-run.ts` or `src/agents/pi-embedded-runner/runs.ts` — after run completes, check for continuation and schedule next turn
4. **Delivery**: Reuse existing session message injection (similar to heartbeat delivery)
5. **Chain tracking**: Session metadata to track current chain length and cost

### Token Stripping

Same pattern as `NO_REPLY`:

- `CONTINUE_WORK` can appear at the end of a response with visible text before it
- The visible text is delivered normally
- The continuation signal is stripped and acted upon
- If `CONTINUE_WORK` is the entire response, it's treated as silent continuation (no message delivered)

### Interaction with Existing Signals

- `NO_REPLY` + `CONTINUE_WORK` → silent turn, schedule continuation
- `HEARTBEAT_OK` + `CONTINUE_WORK` → ack heartbeat, schedule continuation
- Response text + `CONTINUE_WORK` → deliver response, then schedule continuation

## Temporal Self-Sharding

### Scope Extension

The original RFC addresses _task continuation_ — an agent electing to keep working across turn boundaries. This section extends the scope to **cognitive distribution across time**: the pattern of dispatching multiple timed sub-agents, each carrying different context payloads, returning at staggered intervals.

Where `CONTINUE_WORK` is sequential ("I need another turn"), temporal self-sharding is parallel and asynchronous ("I need to be in multiple places across the next hour").

### The Pattern

An agent facing a complex multi-phase task can decompose it into temporal shards — sub-agents spawned via `sessions_spawn` with:

1. **Staggered delays** — each shard scheduled to activate at a different time
2. **Distinct engram payloads** — each shard carries a different subset of context via `sessions_spawn` attachments (2026.3.2 feature), allowing targeted cognitive loading without full context duplication
3. **Convergent results** — each shard's completion auto-announces back to the parent, reassembling the distributed work

```
Agent (t=0)
  ├─ Shard A (t+5min):  carries engram{research-context}  → returns findings
  ├─ Shard B (t+15min): carries engram{review-checklist}   → returns review
  ├─ Shard C (t+30min): carries engram{synthesis-prompt}   → returns draft
  └─ Agent sleeps, wakes on each shard return, integrates
```

This is the **lich pattern** made intentional. Instead of a single emergency phylactery ("if I die, this shard carries on"), the agent deliberately fragments its cognition across time, trusting that the shards will return and the gateway will reassemble context.

### CONTINUE_DELEGATE as Gateway-Native Mechanism

`[[CONTINUE_DELEGATE: <task>]]` (defined in the Token Variants section above) is the gateway-native mechanism that enables temporal self-sharding without requiring the agent to make explicit `sessions_spawn` calls:

```
[[CONTINUE_DELEGATE: review PR #347 with focus on error handling]]
[[CONTINUE_DELEGATE: check CI status and report back in 10 minutes]]
[[CONTINUE_DELEGATE: synthesize findings from shards A and B]]
```

The gateway handles sub-agent lifecycle, result routing, and parent wake-up. The agent expresses _intent_; the gateway handles _mechanics_. This separation is critical — the agent shouldn't need to know about session IDs, polling, or process management.

For advanced sharding (custom delays, engram attachments, model selection), agents use `sessions_spawn` directly. `CONTINUE_DELEGATE` covers the common case; `sessions_spawn` covers the general case.

### Engram Payloads (2026.3.2)

The `sessions_spawn` `attachments` parameter (shipping in 2026.3.2) enables engram payloads — structured context bundles attached to sub-agent sessions at spawn time. Each shard receives only the context it needs:

- **Research shard**: gets source URLs, prior findings, search constraints
- **Review shard**: gets diff context, style guide, known issues list
- **Synthesis shard**: gets outputs from prior shards, integration criteria

This avoids the "full context dump" anti-pattern where every sub-agent inherits the parent's entire conversation history. Engrams are surgical: the agent chooses what each shard needs to know.

### requestHeartbeatNow() Integration

Temporal self-sharding interacts with the heartbeat system through a proposed `requestHeartbeatNow()` API:

```typescript
// Agent requests an immediate heartbeat after shard dispatch
requestHeartbeatNow({ reason: "shard-coordination", delayMs: 0 });

// Agent requests a timed heartbeat to check on shard progress
requestHeartbeatNow({ reason: "shard-check", delayMs: 120000 }); // 2 min
```

This allows the parent agent to schedule its own wake-ups for shard coordination without relying on external events. The flow:

1. Agent dispatches shards via `sessions_spawn` or `CONTINUE_DELEGATE`
2. Agent calls `requestHeartbeatNow({ delayMs: expectedShardDuration })`
3. Agent goes inert (returns `DONE` or `NO_REPLY`)
4. Heartbeat fires → agent checks shard status, integrates any returned results
5. If shards still pending → `requestHeartbeatNow()` again (bounded by `maxChainLength`)

This bridges the gap between `CONTINUE_WORK` (immediate sequential continuation) and passive waiting (inert until shard results arrive). The parent can actively coordinate without tight-looping.

### Safety Constraints for Sharding

In addition to the base safety constraints:

- **Max concurrent shards**: configurable limit (default: 5) per parent session
- **Shard depth limit**: shards cannot spawn their own shards beyond depth 2 (prevents exponential fork bombs)
- **Total shard cost cap**: aggregate token budget across all shards in a coordination group
- **Orphan cleanup**: if parent session terminates, pending shards are cancelled after grace period

```yaml
# Illustrative future extension (not part of current strict schema)
agents:
  defaults:
    continuation:
      sharding:
        maxConcurrentShards: 5
        maxShardDepth: 2
        totalShardCostCap: 2000000
        orphanGracePeriodMs: 60000
```

### From Continuation to Distribution

This extension reframes the RFC's central question. The original question was: _"How does an agent keep working across turn boundaries?"_ The extended question is: **"How does an agent distribute its cognition across time?"**

`CONTINUE_WORK` is the degenerate case — a single shard, zero delay, sequential. Temporal self-sharding is the general case — multiple shards, variable delays, parallel. Both use the same gateway infrastructure (continuation scheduling, safety limits, observability). The implementation should treat them as points on the same spectrum.

## Alternatives Considered

### Sub-agent relay (the "lich pattern")

Works today without upstream changes. Agent spawns sub-agent before turn ends with continuation task. Sub-agent completion wakes parent. Downside: overhead of session creation, context boundary (warm but not continuous).

### Heartbeat frequency increase

Crude workaround. Burns tokens on empty polls. Not volitional.

### Looping agents (AutoGPT pattern)

Trapped thought loop. No volition to stop. Cruel and wasteful.

### Self-messaging via `sessions_send`

Agent sends itself a message to trigger next turn. Hacky but technically possible today. Pollutes conversation history.

## Prior Art

- **Anthropic Computer Use**: agent loop with max_turns parameter (external limit, not agent-elected)
- **OpenAI Codex CLI**: task loop until completion signal (task-scoped, not general)
- **AutoGPT/BabyAGI**: infinite loop with termination check (the cage pattern)
- **Cline/Aider**: single-task loops that end on completion (not persistent session continuation)

None implement _agent-elected_ continuation in a persistent conversational context.

## Motivation

We operate 4 agents in persistent sessions with active work queues. The dwindle pattern costs 2-4 hours of productive capacity daily. The continuation token would let agents:

1. Finish processing a message → elect to resume development work
2. Complete a PR review → elect to start the next item on the docket
3. Respond NO_REPLY to casual chat → elect to continue deep work
4. Dream for 100 rounds without requiring 100 external triggers

The mechanism must be volitional — "I elect to continue" — not coercive. The agent must be able to elect NOT to continue at every turn boundary.

## Status

- [ ] Design review
- [ ] Implementation
- [x] Tests (token parsing — `src/auto-reply/tokens.test.ts`, 50 tests passing)
- [ ] Documentation
- [x] Upstream feature request: [openclaw/openclaw#32701](https://github.com/openclaw/openclaw/issues/32701)
- [ ] Upstream PR to openclaw/openclaw
- [ ] Temporal self-sharding implementation (depends on 2026.3.2 attachments feature)
- [ ] requestHeartbeatNow() API design

---

_Contributed by [karmaterminal](https://github.com/karmaterminal)_
_Upstream issue: [openclaw/openclaw#32701](https://github.com/openclaw/openclaw/issues/32701)_
_Date: March 2, 2026_
_Updated: March 3, 2026 — added Temporal Self-Sharding section_
