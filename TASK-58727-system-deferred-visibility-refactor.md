# Task: #58727 System-level deferred visibility refactor

Issue: https://github.com/openclaw/openclaw/issues/58727

## Goal

Fix the internal-text leakage problem at the system boundary level, not with ad hoc filtering.

Core rule:

> Any text that can be delivered to users must come from an explicitly user-visible payload. Internal prompts, working text, queue scaffolding, and runtime text must never be rendered or delivered by fallback.

---

## Architectural direction

### 1. Replace prompt-centric deferred delivery with explicit domains

Separate these concepts across the system:

- execution payload
- deferred delivery payload
- user-visible output payload

### 2. Introduce explicit visibility

Recommended first-pass enum:

- `internal`
- `summary-only`
- `user-visible`

### 3. Unify deferred item structure

Target direction:

- `execution` domain for agent/runtime input
- `display` domain for user-visible or summary-only content
- `delivery` domain for routing/thread/origin
- `metadata` for source tracing and ids

### 4. Drain/render must consume only display payloads

Queue drain logic must stop reading internal execution text directly.

### 5. Add a final outbound guard

Any deferred payload headed to user delivery must pass an explicit visibility check.

---

## Single-PR task plan

_Status legend_: `done` = landed and broadly validated, `partial` = main direction landed but cleanup or edge-case closure remains, `todo` = not done yet.

### Task 1 — Introduce shared visibility/deferred contracts

**Status:** `done`

Progress evidence:

- Added explicit visibility model in `src/utils/deferred-visibility.ts`
- Added shared deferred render contract in `src/utils/deferred-render.ts`
- Added shared user-visible payload/assertion helpers in `src/utils/user-facing-content.ts`
- Added focused tests in:
  - `src/utils/deferred-visibility.test.ts`
  - `src/utils/deferred-render.test.ts`
  - `src/utils/user-facing-content.test.ts`

Notes:

- First-pass visibility model (`internal` / `summary-only` / `user-visible`) is in place.
- Shared assertion boundary exists and is already used by follow-up / announce delivery paths.

### Task 2 — Migrate follow-up queue

**Status:** `partial`

Files involved:

- `src/auto-reply/reply/queue/types.ts`
- `src/auto-reply/reply/queue/state.ts`
- `src/auto-reply/reply/queue/drain.ts`
- `src/auto-reply/reply/agent-runner.ts`
- related queue/enqueue helpers and tests

Progress evidence:

- execution input now uses `agentPrompt`
- queued follow-up items now carry explicit `display` payloads
- collect mode batch rendering goes through deferred display helpers
- regression coverage added in `src/auto-reply/reply/reply-flow.test.ts`

Desired result:

- execution input uses `agentPrompt`
- queued follow-up items no longer use raw `prompt` as render source
- collect mode renders only explicit display payloads

Remaining gaps to close:

- collect fallback behavior still needs final cleanup in `src/auto-reply/reply/queue/drain.ts`
- mixed collect batches / retry semantics / overflow-summary behavior still have unresolved edge cases
- latest branch state still contains WIP follow-up for Task 5 cleanup on top of this migration

### Task 3 — Migrate announce queue

**Status:** `partial`

Files involved:

- `src/agents/subagent-announce-queue.ts`
- `src/agents/subagent-announce-delivery.ts`
- announce dispatch/tests

Progress evidence:

- queued announce items use explicit `display` payloads
- announce delivery has tests that reject non-user-visible outbound payloads
- coverage added to ensure `triggerMessage` is not used as direct user-visible fallback

Desired result:

- `triggerMessage` remains internal/event input only
- queued announce rendering uses only explicit display payloads
- no fallback from internal trigger text to user-visible delivery

Remaining gaps to close:

- collect fallback / retry behavior in announce queue still has unresolved edge cases
- external delivery path still needs final confirmation that non-renderable summary-only payloads never wedge the queue
- some unresolved review comments still point at announce fallback semantics

### Task 4 — Add outbound visibility guard

**Status:** `done`

Potential areas:

- delivery/send boundary helpers
- agent/gateway message dispatch boundary
- deferred-delivery send paths

Progress evidence:

- explicit outbound assertion helpers now reject non-user-visible payloads
- follow-up boundary tests reject `summary-only` direct send
- announce boundary tests reject non-user-visible queued payloads

Desired result:

- `internal` payloads cannot be delivered
- `summary-only` payloads cannot be direct-sent as user-visible text
- legacy prompt-only deferred items are rejected during migration cleanup

Notes:

- Boundary guard is in place, though legacy cleanup still depends on Task 5 finishing fully.

### Task 5 — Remove legacy prompt-based rendering and add regressions

**Status:** `partial`

Required cleanup:

- remove `item.prompt` render usage from deferred drains
- remove legacy deferred prompt fields where safe
- add regression coverage for boundary leaks

Progress evidence:

- large regression expansion landed across follow-up and announce tests
- major raw-prompt fallback paths have been replaced with explicit display handling
- multiple fixup commits already target collect fallback, overflow summary, and boundary-leak regressions

Remaining gaps to close:

- final collect fallback cleanup is still in progress
- unresolved review comments still exist around:
  - mixed display/non-display collect batches
  - forced-individual retry semantics
  - overflow summary emission / retry-loop prevention
  - summary-only edge-case handling in fallback paths
- latest branch commit is still explicitly WIP: `wip(reply): continue task5 collect fallback fixes`

---

## Invariants to enforce

- Internal execution text never becomes user-visible by fallback.
- Queue/drain/render code does not derive user output from raw internal prompt text.
- User-visible delivery requires explicit `user-visible` payloads.
- Summary-only content may be summarized but not directly emitted.

---

## Regression coverage to add

### Follow-up queue

- internal-only item does not leak in collect mode
- user-visible item can be collected and sent
- summary-only item contributes to summary but is not emitted raw
- mixed batches do not surface internal text

### Announce queue

- `triggerMessage` is never used as collect render source
- queued announce delivery only uses explicit display payloads
- summary-only announce items are not direct-sent

### Busy/deferred delivery

- active busy queue does not later emit internal continuation text
- late completion paths only emit explicit display payloads
- `NO_REPLY` / silent-turn paths do not expose internal scaffolding

### Outbound guard

- rejects internal deferred payloads
- rejects summary-only direct send
- rejects legacy prompt-only deferred items once migration reaches cleanup phase

---

## Engineering constraint to add

Add a project rule / guardrail:

- queue/drain/render code must not construct user-visible output from `prompt`, `triggerMessage`, `continuationInput`, or equivalent internal-only fields

Possible enforcement:

- lint rule
- contract test
- focused code-search test

---

## PR framing

Suggested title direction:

- `refactor: separate internal execution prompts from user-visible deferred delivery`

Suggested PR framing:

- this is a system-level boundary refactor
- not an ad hoc filtering patch
- unifies deferred delivery semantics across follow-up and announce paths
- eliminates raw internal prompt fallback into user-visible output
