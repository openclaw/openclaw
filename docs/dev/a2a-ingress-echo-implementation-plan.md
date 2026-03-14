# A2A Ingress Echo Implementation Plan

Status: proposed (implementation-ready)
Owner: dev-openclaw
Scope: additive, backward-compatible `sessions_send` ingress echo so recipient-agent channel delivery can happen before the native target run.

## Why this plan exists

Current `sessions_send` behavior already has two important pieces:

1. **native inter-session execution** via the target session run, and
2. **post-run announce delivery** via the existing A2A flow.

That is close, but it does **not** satisfy the desired UX for agent-to-agent relay across channel-bound agents such as `gpod -> googleworkspace-cli`.

Desired behavior for this milestone:

- the original `sessions_send` payload is **echoed into the recipient agent's bound Slack/channel session first**,
- the recipient agent still **processes that same payload natively** in its internal session,
- existing installs remain unchanged unless the feature is explicitly enabled.

This plan keeps `sessions_send` as the control plane and adds a config-gated **ingress echo** step before the target run.

---

## Definition of success

When agent A calls `sessions_send` against agent B:

1. OpenClaw resolves whether the target session has a deliverable announce/channel target.
2. If ingress echo is enabled, OpenClaw attempts to post an echo of the original message into that target channel **before** starting the target agent run.
3. OpenClaw then runs the target agent natively using the same message body and existing provenance/context machinery.
4. Existing `sessions_send` result fields stay compatible.
5. New result fields describe ingress-echo outcome without breaking older callers.

---

## Non-goals for this iteration

- Replacing native A2A transport with Slack or any other channel transport.
- Turning follow-up ping-pong replies into channel-native relay.
- Broad message formatting customization.
- Full anti-loop policy redesign.
- New delivery backends beyond the existing `send` pathway.

Those can come later if needed. This milestone is intentionally narrow.

---

## Current baseline (important)

Today, the relevant flow is roughly:

- `sessions-send-tool.ts`
  - validates target access
  - starts the target agent run via gateway `agent`
  - optionally waits
  - then starts `runSessionsSendA2AFlow(...)`
- `sessions-send-tool.a2a.ts`
  - optionally runs ping-pong turns
  - runs an **announce step** on the target agent
  - best-effort sends the announce reply to the target channel
- `sessions-announce-target.ts`
  - resolves the most plausible deliverable target for an existing session
- `sessions-send-helpers.ts`
  - holds A2A context builders and ping-pong config resolution

This means we already have:

- channel-target resolution,
- best-effort channel delivery plumbing,
- target-side A2A prompting,
- reply-loop mechanics.

The missing piece is **pre-run ingress delivery of the original message**.

---

## Key design decisions

### 1) Keep `sessions_send` as the control plane

The native session run remains the source of truth.

Ingress echo is an additive side effect around that flow, not a new transport model.

### 2) Gate the feature in config, default off

Behavior must be unchanged for existing users unless explicitly enabled.

### 3) Echo occurs before target run

Ordering is the feature.

If the target channel is meant to reflect what the recipient agent is being asked to do, delivery has to happen before the internal run starts.

### 4) Result shape stays additive

Existing consumers should continue to rely on:

- `status`
- `runId`
- `reply`
- `sessionKey`
- existing delivery metadata

New ingress-echo data should be added as a nested object rather than changing existing top-level semantics.

### 5) Keep v1 formatting boring

Ingress echo should closely mirror the original `message` payload.

For v1, the formatting should be intentionally simple and deterministic, for example:

- a minimal prefix identifying the sender/session, and
- the original message body without summarization or model-generated rewriting.

The point is observability and UX continuity, not clever presentation.

---

## Proposed config shape (additive)

Add under `session.agentToAgent`:

```yaml
session:
  agentToAgent:
    maxPingPongTurns: 5
    ingressEcho:
      enabled: false
      requireDelivery: false
```

### Semantics

- `enabled=false`
  - current behavior; no ingress echo attempted
- `enabled=true`
  - attempt ingress echo before the target run
- `requireDelivery=false`
  - best effort: if echo fails, still run target agent
- `requireDelivery=true`
  - strict mode: if echo fails, do not run target agent

### Explicitly deferred

Not needed for the first PR unless formatting churn appears immediately:

- `format`
- `prefixTemplate`
- per-channel overrides
- idempotency-specific knobs

---

## Proposed result shape (additive)

`sessions_send` should retain current fields and add something like:

```json
{
  "runId": "...",
  "status": "ok",
  "sessionKey": "agent:googleworkspace-cli:slack:channel:C123",
  "reply": "...",
  "delivery": {
    "status": "pending",
    "mode": "announce"
  },
  "ingressEcho": {
    "status": "sent",
    "channel": "slack",
    "to": "channel:C123",
    "messageId": "...",
    "threadId": "..."
  }
}
```

Suggested `ingressEcho.status` values:

- `disabled`
- `not_applicable` (no resolvable channel target)
- `pending` (only if needed internally; avoid exposing unless meaningful)
- `sent`
- `failed`
- `blocked` (strict mode prevented run)

If strict mode prevents the run, the top-level tool result should still be explicit and machine-readable.

---

## Workstreams and file touchpoints

## Workstream A — Config model and docs plumbing

### A1. Extend runtime config types

**Primary files**

- `src/config/types.base.ts`
- `src/config/zod-schema.session.ts`
- `src/config/schema.labels.ts`
- `src/config/schema.help.ts`
- `docs/concepts/session-tool.md`
- `docs/gateway/configuration-reference.md` (if generated/maintained from schema paths)

**Changes**

- Add `session.agentToAgent.ingressEcho.enabled?: boolean`
- Add `session.agentToAgent.ingressEcho.requireDelivery?: boolean`
- Add schema labels/help text describing ordering and strict-vs-best-effort behavior
- Update session-tool docs to describe the new pre-run echo semantics

**Acceptance criteria**

- Config validates with and without new fields.
- Old config remains valid unchanged.
- Help text clearly explains that ingress echo is default-off and occurs before the target run.

---

## Workstream B — Announce-target and echo-context helpers

### B1. Add shared ingress-echo helper surface

**Primary files**

- `src/agents/tools/sessions-send-helpers.ts`
- `src/agents/tools/sessions-announce-target.ts`

**Changes**

- Add a helper to resolve ingress-echo policy from config.
- Add a helper to build the echoed text from:
  - requester session key / label (when available)
  - requester channel (when available)
  - target session key / display key
  - original message body
- Reuse `resolveAnnounceTarget(...)` where possible so ingress echo and announce step do not drift.
- If needed, harden announce-target lookup so thread/channel/account metadata is preserved consistently.

**Acceptance criteria**

- Ingress echo uses the same target-resolution strategy as downstream announce delivery unless there is an explicit reason to diverge.
- Echo text generation is deterministic and unit-testable.

---

## Workstream C — Pre-run ingress echo in `sessions_send`

### C1. Insert echo attempt before `agent` run

**Primary files**

- `src/agents/tools/sessions-send-tool.ts`

**Changes**

- Resolve ingress-echo config after target visibility/access is known.
- Resolve announce/channel target for the target session.
- If echo is enabled and target is deliverable:
  - send the echo via gateway `send`
  - capture structured metadata from the send result where available
- If echo fails:
  - in best-effort mode, continue to native target run
  - in strict mode, return a blocking result and skip the target run entirely
- Preserve the existing target run path, wait path, ping-pong path, and announce step.

**Ordering invariant**

The echo send attempt must happen before the target `agent` call.

**Acceptance criteria**

- Best-effort mode does not change native run behavior when echo delivery fails.
- Strict mode prevents the run when delivery is required and fails.
- Existing success/timeout/error semantics remain intact.

---

## Workstream D — Result envelope extension

### D1. Add structured ingress-echo status to responses

**Primary files**

- `src/agents/tools/sessions-send-tool.ts`
- relevant tool-schema/test snapshots if any exist

**Changes**

- Add `ingressEcho` to every `sessions_send` result path where practical:
  - disabled
  - success
  - failure
  - strict-blocked
  - timeout/no-timeout run paths
- Keep fields additive and stable.

**Acceptance criteria**

- Callers that ignore `ingressEcho` continue to work.
- Callers that need observability can reliably inspect `ingressEcho.status`.

---

## Workstream E — Test coverage

### E1. Session tool tests

**Primary files**

- `src/agents/openclaw-tools.sessions.test.ts`
- `src/agents/tools/sessions.test.ts`
- `src/gateway/server.sessions-send.test.ts`

**Recommended cases**

1. **Echo success, wait path**
   - ingress echo enabled
   - `send` succeeds
   - target run succeeds
   - assert echo attempted before target run
   - assert result includes `ingressEcho.status = "sent"`

2. **Echo success, fire-and-forget path**
   - `timeoutSeconds = 0`
   - echo still attempted before target run
   - result is `accepted`
   - `ingressEcho` included

3. **Best-effort failure**
   - echo enabled, `requireDelivery = false`
   - `send` fails
   - target run still occurs
   - result includes `ingressEcho.status = "failed"`

4. **Strict failure**
   - echo enabled, `requireDelivery = true`
   - `send` fails
   - target run does not occur
   - result reflects blocked/error state with `ingressEcho.status = "blocked"` or equivalent

5. **No resolvable target**
   - ingress echo enabled
   - announce target cannot be resolved
   - strict vs best-effort semantics are explicit and tested

6. **Backward compatibility**
   - ingress echo disabled
   - existing test expectations continue to pass with minimal/no changes beyond additive fields

### E2. Gateway loopback / integration assertions

Add at least one loopback test covering:

- the tool request,
- ingress echo send,
- target run,
- final result envelope.

**Acceptance criteria**

- Tests explicitly prove the pre-run ordering guarantee.
- Tests cover both timeout and no-timeout execution paths.

---

## Workstream F — Follow-up guardrails (separate PR)

Status update (2026-03-09): nested relay guard has now been started after the ingress-echo MVP landed and the e2e harness issue was fixed.

This should be a **second PR**, not mixed into the ingress-echo implementation unless required for safety.

### F1. Nested relay guard

**Goal**

Prevent runaway A↔B cascades where an inbound inter-session message triggers another `sessions_send` hop by default.

**Potential config**

```yaml
session:
  agentToAgent:
    guard:
      allowNestedSessionsSend: false
```

**Behavior**

- If current inbound provenance is already `inter_session` from `sessions_send`, block further nested relay unless explicitly allowed.

### F2. Preserve existing ping-pong cap

Continue using:

- `session.agentToAgent.maxPingPongTurns`

This already provides an important ceiling and should remain independent from ingress echo.

---

## Recommended execution sequence

### PR 1 — Ingress echo MVP

Includes:

- config fields
- helper(s)
- pre-run echo step
- additive result envelope
- tests
- docs

This is the milestone that satisfies the concrete user requirement.

### PR 2 — Guardrails

Includes:

- nested relay guard
- any additional loop/cost controls
- follow-up tests

Keeping this separate reduces risk and review noise.

---

## Risks and mitigations

### Risk: behavior ambiguity between ingress echo and final announce

**Mitigation**

Keep the concepts separate in code and docs:

- **ingress echo** = pre-run copy of the original request
- **announce step** = post-run target-authored outward response

### Risk: duplicate-looking channel messages

**Mitigation**

Accept this in v1 as an intentional tradeoff:

- first message = what the target agent was asked to do
- later message = what the target agent decided to announce after working

If this becomes noisy, solve it later with formatting or policy—not by skipping the initial requirement.

### Risk: flaky target resolution across channel/thread surfaces

**Mitigation**

Reuse existing `resolveAnnounceTarget(...)` machinery and expand tests around thread/account metadata.

### Risk: strict mode surprises users

**Mitigation**

Default `requireDelivery` to `false` and document the contract clearly.

---

## Acceptance criteria

This plan is complete when all are true:

1. `sessions_send` can optionally echo the original payload into the recipient agent's channel before native execution.
2. The recipient agent still processes the same payload natively using the existing run path.
3. Existing behavior is unchanged when ingress echo is disabled.
4. Strict mode can block the run if delivery is required and fails.
5. Tool results expose structured ingress-echo status additively.
6. Tests prove ordering, strict-vs-best-effort behavior, and compatibility.

---

## Suggested filename and placement

This document belongs in:

- `docs/dev/a2a-ingress-echo-implementation-plan.md`

If/when implementation lands, user-facing behavior docs should be updated in:

- `docs/concepts/session-tool.md`
- config reference/help generated from schema/help paths
