# pending-final-delivery vs heartbeat stall investigation

## Question

Can the draft PR work on `pendingFinalDelivery` / subagent final delivery reliability help with the recent "assistant got stuck after heartbeat/system events" behavior seen in the main session?

## Short answer

Not directly.

The draft PR hardens **subagent completion delivery**.
The current symptom looks like a **main-session turn interruption / heartbeat preemption / missing resume path** problem.

## Why the PR does not directly apply

The `pendingFinalDelivery*` state is currently stored on `SubagentRunRecord` and belongs to the subagent registry lifecycle.

Relevant files:

- `openclaw-src/src/agents/subagent-registry.types.ts`
- `openclaw-src/src/agents/subagent-registry-lifecycle.ts`

That means the mechanism is specifically about:

- child run completion
- announce retry
- durable completion payload recovery
- subagent restart / steer replacement safety

It does **not** cover plain main-session work such as:

- direct `exec` / `process` flows
- heartbeat prompts arriving in the main session
- generic "resume the user-facing reply after an interrupting system event" behavior

## What looks closer to the current issue

Relevant files:

- `openclaw-src/src/infra/heartbeat-events-filter.ts`
- `openclaw-src/src/infra/heartbeat-runner.skips-busy-session-lane.test.ts`
- `openclaw-src/src/cron/service/timer.ts`

Observations:

- exec completions are classified as heartbeat/system events and get their own relay prompt path
- heartbeat logic already knows how to skip when a session lane is busy (`requests-in-flight`)
- but this is about heartbeat/event routing, not subagent durable final delivery

## Working theory for the recent stalls

The recent stalls are more likely caused by a combination of:

1. a long-running user-directed turn in the main session
2. interrupting system or heartbeat events arriving
3. no generic durable "resume final user reply" state for plain main-session work
4. the assistant ending up acknowledging the interrupting turn without resuming the original conversation outcome

## Where the draft PR may still help conceptually

Conceptually, yes.

The PR suggests a reusable pattern:

- persist a pending final delivery marker
- keep the payload durable
- retry final user delivery after interruptions or restarts
- avoid stale payload reuse by binding state to the correct run identity

That pattern could be generalized beyond subagents.

## Better candidate follow-up fix

A better fix for this exact class of issue would likely be one of these:

### Option A, generic pending final delivery for main-session async events

Track durable pending user delivery not only for subagents, but also for:

- exec completion relays
- cron/user-reminder relays
- heartbeat-triggered follow-ups

### Option B, interrupt-safe resume for main-session turns

When a heartbeat/system event interrupts or preempts a session, keep a resumable pointer to the last user-directed unfinished turn and re-wake it after the interrupting event is handled.

### Option C, stricter heartbeat suppression while active user work is in progress

If the session is handling a user-requested multi-step task, suppress or defer non-urgent heartbeat prompts more aggressively.

## Current conclusion

- **As-is:** the draft PR probably does **not** fix the current stall.
- **As a design pattern:** yes, it is relevant and likely points toward the right family of fix.
- **Most likely real fix:** generalized pending-final-delivery or resume-after-interrupt support for main-session event relays, not only subagents.
