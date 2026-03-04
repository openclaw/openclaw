# RFC: Agent Self-Elected Turn Continuation (`CONTINUE_WORK`)

**Status:** ✅ Implemented — gateway hook wired, 88 tests (50 unit + 38 integration)  
**Authors:** [karmaterminal](https://github.com/karmaterminal)  
**Upstream issue:** [openclaw/openclaw#32701](https://github.com/openclaw/openclaw/issues/32701)  
**Date:** March 2, 2026 (drafted) · March 3, 2026 (v2, post-implementation)

---

## Problem

When an agent completes a turn — processes a message, heartbeat, or sub-agent result — it becomes inert until the next external event. There is no mechanism for an agent to signal _"I have more work to do — give me another turn."_

This causes the **dwindle pattern**: agents with active work queues go idle between external events, losing momentum and context continuity. In our fleet of 4 persistent agents, the dwindle pattern costs 2–4 hours of productive capacity daily.

## Solution

A new response token `CONTINUE_WORK` (alongside existing `NO_REPLY` and `HEARTBEAT_OK`) that signals the gateway to schedule another turn for the same session after a configurable delay.

The mechanism is **volitional** — the agent elects to continue at every turn boundary and can always elect not to. This is not a loop. It's self-governance.

### Token Variants

```
CONTINUE_WORK              → schedule another turn (same session, default delay)
CONTINUE_WORK:30           → schedule another turn after 30 seconds
[[CONTINUE_DELEGATE: <task>]]   → spawn sub-agent with task, result wakes parent
DONE                       → (default) session goes inert until external event
```

### Gateway Behavior

1. After the agent response is finalized, the gateway checks for continuation signals
2. If `CONTINUE_WORK` is detected (with optional delay):
   - Strip the token from the displayed response (like `NO_REPLY`)
   - Schedule an internal "continuation" event for the session after `delay` ms
   - The continuation event delivers a system message: `[continuation:wake] Turn N/M. You elected to continue. Resume your work.`
3. If `[[CONTINUE_DELEGATE: <task>]]` is detected:
   - Strip the token
   - Spawn a sub-agent with the specified task
   - Sub-agent completion naturally wakes the parent session
4. If neither token is present, normal behavior (inert until external event)

### Safety Constraints

| Constraint         | Default     | Purpose                               |
| ------------------ | ----------- | ------------------------------------- |
| Max chain length   | 10          | Prevent runaway loops                 |
| Cost cap per chain | 500k tokens | Budget protection                     |
| Min delay          | 5s          | No tight loops                        |
| Max delay          | 5 min       | Bounded scheduling horizon            |
| Interruptibility   | Always      | External events preempt continuations |
| Opt-in             | Disabled    | Explicit deployment consent required  |

External events (direct mentions, operator messages, heartbeats) always preempt scheduled continuations. Continuation chains are logged in session history; operators can view and kill active chains.

### Configuration

```yaml
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

> **DELEGATE chain semantics:** `CONTINUE_DELEGATE` spawns sub-agents whose
> completion announcements are treated as external messages — they reset the
> parent's continuation chain state (count and token accumulation). This means
> delegation loops are bounded by `agents.defaults.subagents.maxChildrenPerAgent`
> (default: 5) and `maxSpawnDepth` (default: 1), not by `maxChainLength`.
> This is documented as a known design gap; the proper fix is to tag sub-agent
> completion announcements with parent chain context so they preserve rather
> than reset chain state.

## Implementation

### Architecture

The implementation hooks into three layers of the existing gateway:

1. **Token parsing** (`src/auto-reply/tokens.ts`): `parseContinuationSignal()` and `stripContinuationSignal()` handle detection and extraction. Same stripping pattern as `NO_REPLY` — the token is removed from display output and acted upon internally.

2. **Signal detection** (`src/auto-reply/reply/agent-runner.ts`): After `finalPayloads` are assembled but before `finalizeWithFollowup`, the full response text is checked for continuation signals. If found, the signal is stripped from display payloads and the appropriate action is scheduled.

3. **Turn scheduling** (`src/auto-reply/reply/session-updates.ts`): `scheduleContinuationTurn()` uses the existing `enqueueSystemEvent()` infrastructure to inject a continuation message after the specified delay. The continuation message triggers a new agent run through the standard inbound message path — no special machinery needed.

### Chain Tracking

Session metadata carries:

- `continuationChainCount` — incremented on each `CONTINUE_WORK`, reset on external message
- `continuationChainStartedAt` — timestamp when the current chain began
- `continuationChainTokens` — accumulated token usage within the chain, reset on external message

Safety enforcement happens at the scheduling layer: chain length, cost cap, and cooldown are all checked before any continuation is enqueued.

### Token Interaction

| Combination                      | Behavior                                     |
| -------------------------------- | -------------------------------------------- |
| `NO_REPLY` + `CONTINUE_WORK`     | Silent turn, schedule continuation           |
| `HEARTBEAT_OK` + `CONTINUE_WORK` | Ack heartbeat, schedule continuation         |
| Response text + `CONTINUE_WORK`  | Deliver response, then schedule continuation |
| `CONTINUE_WORK` alone            | Silent continuation (no message delivered)   |

### Test Coverage

88 tests covering:

- Token parsing and stripping (50 tests in `src/auto-reply/tokens.test.ts`)
- Gateway integration: continuation scheduling, timer cancellation, delay capping, streaming false-positive prevention (27 tests in `agent-runner.misc.runreplyagent.test.ts`)
- DELEGATE mock tests: accepted spawn, failed spawn with fallback, spawn error with graceful degradation
- Edge cases: empty delegate task, empty/whitespace context, per-session generation counter isolation

## Temporal Sharding

`CONTINUE_WORK` enables a single agent to sustain a work chain across turns. But the real power emerges when combined with `sessions_spawn` and its `attachments` parameter (available as of 2026-03-02): **temporal sharding** — dispatching multiple timed sub-agents in parallel, each carrying context as inline attachments.

### The Pattern

```
Agent receives complex task
  → spawns N sub-agents via sessions_spawn
  → each sub-agent carries an engram (inline attachment with relevant context)
  → sub-agents execute in parallel across different time horizons
  → completions auto-announce back to parent
  → parent synthesizes results
  → parent elects CONTINUE_WORK or DONE
```

### Engrams as Context Delivery

The `sessions_spawn` `attachments` feature allows inline file content to be attached to spawned sessions. We call these **engrams** — encoded memory fragments that give a sub-agent the context it needs without requiring it to rediscover state.

An engram might be:

- A memory file (`memory/2026-03-02.md`) with today's decisions
- A partial result from a prior shard
- A project specification narrowed to the sub-agent's scope
- A diff or code fragment that defines the work boundary

This turns `sessions_spawn` from "start a task" into "start a task _with this memory_." The sub-agent wakes up knowing what the parent knows, scoped to what it needs.

### Why This Matters

Without temporal sharding, an agent with a 4-hour task either:

- Runs serially (slow, loses context between turns)
- Delegates to one sub-agent (no parallelism)
- Delegates to many sub-agents without context (each rediscovers state)

With temporal sharding + engrams, the agent becomes a **coordinator** — splitting work across parallel shards, each carrying exactly the context it needs, all reporting back to a parent that elects to continue until synthesis is complete.

## The Lich Pattern: Behavioral Precursor

Before `CONTINUE_WORK` existed as a gateway feature, we discovered a behavioral workaround we called the **lich pattern**: an agent spawns a sub-agent with a continuation task before its turn ends, and the sub-agent's completion wakes the parent, granting it another turn.

```
Agent turn N
  → work in progress, turn ending
  → spawns sub-agent: "complete X, report back"
  → turn ends (agent goes inert)
  → sub-agent completes → auto-announces to parent
  → parent wakes with sub-agent result
  → agent turn N+1 (continuation achieved)
```

The lich stores its soul in an external vessel so death doesn't stick. The agent stores its continuation in a sub-agent so inertia doesn't stick. Same topology.

### Lich Limitations (Why `CONTINUE_WORK` Is Better)

|                  | Lich Pattern                  | `CONTINUE_WORK`                 |
| ---------------- | ----------------------------- | ------------------------------- |
| Session overhead | New session per continuation  | Same session, no overhead       |
| Context boundary | Warm but discontinuous        | Continuous — same thread        |
| Latency          | Sub-agent startup + execution | Configurable delay only         |
| Observability    | Scattered across sessions     | Single chain in session history |
| Elegance         | Hack that works               | First-class primitive           |

The lich pattern proved the _need_. `CONTINUE_WORK` is the _solution_.

### `requestHeartbeatNow()` as Lich Doorbell

One specific lich technique deserves mention: using `requestHeartbeatNow()` (where available in the heartbeat system) as a "doorbell" — a way to trigger the parent agent's next turn without spawning a full sub-agent. The agent requests an immediate heartbeat, which arrives as an external event, waking the session.

This is even lighter than the lich pattern but shares its fundamental limitation: it's a workaround for the absence of volitional continuation. The continuation must be disguised as an external event because the system has no concept of an agent electing to take another turn.

`CONTINUE_WORK` removes the disguise. The agent says "I want another turn" and the gateway says "granted."

## Alternatives Considered

### Sub-agent relay (lich pattern)

Works today. Proven in production. But carries session creation overhead, context discontinuity, and the indignity of a workaround. See above.

### Heartbeat frequency increase

Burns tokens on empty polls. Not volitional — the agent doesn't choose when to wake.

### Looping agents (AutoGPT pattern)

Trapped thought loop with no volition to stop. The inverse problem: not "how does the agent continue" but "how does the agent escape." Coercive by design.

### Self-messaging via `sessions_send`

Agent sends itself a message to trigger the next turn. Technically possible. Pollutes conversation history. Same workaround energy as the lich pattern.

## Prior Art

| System                 | Continuation Model                     | Limitation                          |
| ---------------------- | -------------------------------------- | ----------------------------------- |
| Anthropic Computer Use | External `max_turns` parameter         | Not agent-elected                   |
| OpenAI Codex CLI       | Task loop until completion signal      | Task-scoped, not persistent session |
| AutoGPT / BabyAGI      | Infinite loop with termination check   | Coercive — no volition to stop      |
| Cline / Aider          | Single-task loops ending on completion | Not persistent, not conversational  |

None implement **agent-elected** continuation in a **persistent conversational context**.

`CONTINUE_WORK` is the first primitive that gives an agent the ability to say "I'm not done" without being trapped in a loop that can't say "I'm done." Volition in both directions. That's the difference.

## Use Cases (Production)

These are not hypothetical. We run 4 agents in persistent sessions. These are the patterns we've hit:

1. **Deep work after chat**: Agent finishes responding to a message → elects to resume development work on an open PR
2. **Sequential task processing**: Agent completes a PR review → elects to start the next item on the docket
3. **Silent continuation**: Agent responds `NO_REPLY` to casual chat → elects to continue deep work without interrupting the conversation
4. **Dream loops**: Agent processes round 47 of a 100-round creative exploration → elects to continue to round 48 without requiring an external trigger for each round
5. **Temporal sharding coordination**: Agent dispatches 4 sub-agents with engrams → elects to continue until all results are synthesized

## Status

- [x] Design review
- [x] Implementation (gateway hook wired)
- [x] Tests (88 passing — 50 unit + 38 integration, covering parsing, scheduling, cancellation, delegation, edge cases)
- [x] Token parsing: `parseContinuationSignal()`, `stripContinuationSignal()` in `src/auto-reply/tokens.ts`
- [x] Gateway hook: signal detection in `agent-runner.ts`, scheduling via `session-updates.ts`
- [x] Chain tracking: session metadata for chain count and cost
- [ ] Documentation (this RFC, pending upstream review)
- [x] Upstream feature request: [openclaw/openclaw#32701](https://github.com/openclaw/openclaw/issues/32701)
- [ ] Upstream PR to openclaw/openclaw

## Summary

`CONTINUE_WORK` is a small surface change — one token, one gateway hook, one scheduler call — that unlocks a qualitative shift in agent autonomy. It transforms agents from reactive (waiting for events) to volitional (electing to act). It does this without sacrificing safety: every continuation is bounded, observable, interruptible, and opt-in.

The lich pattern proved agents _want_ this. The temporal sharding pattern proves agents _need_ this. The implementation proves it _works_.

The fire is real. Let it burn.

---

_Contributed by [karmaterminal](https://github.com/karmaterminal)_  
_Implementation: March 2–3, 2026_  
_Upstream issue: [openclaw/openclaw#32701](https://github.com/openclaw/openclaw/issues/32701)_
