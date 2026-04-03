# Message Latency Instrumentation

## Goal

When a user says "this chat feels stuck", we should be able to answer:

- how long the message waited before OpenClaw started meaningful work
- how long we spent deciding queue / supervisor / ACP routing
- how long the backend took to produce the first useful output
- how long delivery spent before the user could actually see something
- whether the turn had a truthful early visible status, and whether that status helped

The design should stay channel-agnostic. Feishu, QQ, Telegram, Slack, and future channels should
emit the same runtime latency contract, even if their render and transport layers differ.

## Problem

Current observability is useful but incomplete.

- `message.first_visible` tells us dispatch-to-first-visible latency, but not where time was spent.
- We can see queue depth and some ACP failures, but we cannot break one slow turn into:
  ingress, arbitration, runtime setup, model/tool work, and delivery.
- Routed replies and active-run status delivery now participate in first-visible tracking, but
  there is still no single timeline that explains end-user wait.

This means we can detect "slow", but not "slow because ACP ensure_session took 5.2s" or
"slow because the run produced nothing visible for 11s after start".

## Principles

- Channel-agnostic first. Runtime defines the timeline. Channels only attach their own transport ids.
- Truthful first-visible semantics. We should measure only real visible delivery, not internal blocks.
- Stage-based, not just one total number. We need additive segments that explain the total wait.
- Low-cardinality default fields. High-cardinality debug detail should be optional.
- Best-effort and non-blocking. Diagnostics must not delay reply delivery.

## Timeline Model

Each inbound turn gets a `turnLatencyId`.

This id ties together the following stages:

1. `turn.ingress.received`
   When the channel adapter accepts the inbound message.

2. `turn.dispatch.started`
   When `dispatchReplyFromConfig()` starts processing the turn.

3. `turn.queue.arbitrated`
   When queue/supervisor arbitration decides `interrupt`, `steer`, `collect`, `queue`, etc.

4. `turn.first_visible.scheduled`
   When runtime decides to schedule a truthful early visible payload such as `status`.

5. `turn.run.started`
   When the actual agent/backend run starts.

6. `turn.run.first_output`
   When the run first produces any candidate output:
   tool summary, tool media, block, status, milestone, or final.

7. `turn.first_visible.emitted`
   When the user first has a visible payload delivered successfully.

8. `turn.final.ready`
   When final user-facing payloads are assembled.

9. `turn.final.emitted`
   When the final payload is delivered successfully.

10. `turn.completed`
    When the turn is fully idle from the runtime point of view.

## Segment Definitions

These segments should be directly derivable from the stage timestamps:

- ingress_to_dispatch
  `turn.dispatch.started - turn.ingress.received`

- dispatch_to_arbitration
  `turn.queue.arbitrated - turn.dispatch.started`

- arbitration_to_status_schedule
  `turn.first_visible.scheduled - turn.queue.arbitrated`

- arbitration_to_run_start
  `turn.run.started - turn.queue.arbitrated`

- run_start_to_first_output
  `turn.run.first_output - turn.run.started`

- dispatch_to_first_visible
  `turn.first_visible.emitted - turn.dispatch.started`

- first_visible_to_final_ready
  `turn.final.ready - turn.first_visible.emitted`

- final_ready_to_final_emit
  `turn.final.emitted - turn.final.ready`

- dispatch_to_complete
  `turn.completed - turn.dispatch.started`

## Required Dimensions

Every latency event should carry:

- `turnLatencyId`
- `sessionKey`
- `sessionId`
- `messageId`
- `channel`
- `originatingChannel`
- `routed`
- `replyGeneration`

When available, also attach:

- `queueModeConfigured`
- `queueModeFinal`
- `supervisorAction`
- `supervisorRelation`
- `firstVisibleKind`
- `provider`
- `model`
- `backend`
- `backendSessionType`

## Optional Breakdown Dimensions

These are useful when present, but should be omitted if expensive or unavailable:

- `activeRun`
- `streamingActiveRun`
- `laneSize`
- `modelArbitratorUsed`
- `modelArbitratorLatencyMs`
- `acpEnsureSessionMs`
- `acpRunStartMs`
- `acpFirstEventMs`
- `toolLoopCount`
- `toolCountBeforeFirstVisible`

## Proposed Diagnostic Events

Keep existing events. Add a small stage-oriented family:

- `turn.latency.stage`
  - fields: `turnLatencyId`, `stage`, `sessionKey`, `sessionId`, `messageId`, `channel`, plus dimensions

- `turn.latency.segment`
  - emitted only at `turn.completed`
  - fields: `turnLatencyId`, `segments`, `firstVisibleKind`, `outcome`

- `turn.latency.timeout`
  - emitted when a stage exceeds a configured threshold
  - examples:
    - `dispatch_to_first_visible`
    - `run_start_to_first_output`
    - `final_ready_to_final_emit`

We should continue emitting `message.first_visible` for backward compatibility, but it should become
an input to the richer timeline rather than the whole story.

## Runtime Seams

### Ingress

Channel handlers emit `turn.ingress.received` as soon as the inbound payload is accepted.

### Dispatch

`dispatchReplyFromConfig()` emits:

- `turn.dispatch.started`
- `turn.first_visible.emitted`
- `turn.final.emitted`
- `turn.completed`

It already owns the first-visible watchdog and is the right place to assemble the final segment summary.

### Queue and Supervisor

`get-reply-run.ts` and `agent-runner.ts` emit:

- `turn.queue.arbitrated`
- `turn.first_visible.scheduled` when truthful status is scheduled
- `supervisorAction` / `supervisorRelation` dimensions

### Backend Runtime

`agent-runner-execution.ts`, ACP dispatch, and embedded PI runner emit:

- `turn.run.started`
- `turn.run.first_output`

ACP-specific diagnostics should also stamp:

- `acp.ensure_session.started`
- `acp.ensure_session.completed`
- `acp.run_turn.started`
- `acp.run_turn.first_event`

These do not need to be user-facing events; they exist to explain long orchestration gaps.

### Delivery

`reply-dispatcher.ts`, routed `routeReply()` paths, and ACP delivery coordinator emit:

- `turn.first_visible.emitted`
- `turn.final.emitted`

This is where transport latency belongs. Channel adapters may add transport ids and provider response
codes, but they should not redefine the stage names.

## Rollout

Phase 1:

- Introduce `turnLatencyId`
- Emit `turn.latency.stage` for dispatch start, arbitration, status scheduled, first visible, final emitted, completed
- Emit `turn.latency.segment` at completion

Phase 2:

- Add backend sub-stages for ACP and embedded PI
- Add timeout alerts for `run_start_to_first_output` and `final_ready_to_final_emit`

Phase 3:

- Build heartbeat summaries and dashboards grouped by channel, backend, queue mode, and first-visible kind
- Compare turns with truthful early status vs no early status

## Success Criteria

For any slow turn, we can answer all of the following from diagnostics alone:

- Was the delay before or after queue/supervisor arbitration?
- Did runtime schedule a truthful early visible status?
- Was the first visible thing a status, block, tool result, or final?
- Was the slow part backend setup, model/tool execution, or channel delivery?
- Did the user wait because of ACP harness/setup retries, or because the run itself stayed silent?
