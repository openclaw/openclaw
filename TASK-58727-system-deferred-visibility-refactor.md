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

### Task 1 — Introduce shared visibility/deferred contracts
- Add explicit visibility model
- Add shared deferred render contract
- Add shared user-visible payload/assertion helpers
- Keep compatibility only where needed for in-PR migration

### Task 2 — Migrate follow-up queue
Files likely involved:
- `src/auto-reply/reply/queue/types.ts`
- `src/auto-reply/reply/queue/state.ts`
- `src/auto-reply/reply/queue/drain.ts`
- `src/auto-reply/reply/agent-runner.ts`
- related queue/enqueue helpers and tests

Desired result:
- execution input uses `agentPrompt`
- queued follow-up items no longer use raw `prompt` as render source
- collect mode renders only explicit display payloads

### Task 3 — Migrate announce queue
Files likely involved:
- `src/agents/subagent-announce-queue.ts`
- `src/agents/subagent-announce-delivery.ts`
- announce dispatch/tests

Desired result:
- `triggerMessage` remains internal/event input only
- queued announce rendering uses only explicit display payloads
- no fallback from internal trigger text to user-visible delivery

### Task 4 — Add outbound visibility guard
Potential areas:
- delivery/send boundary helpers
- agent/gateway message dispatch boundary
- deferred-delivery send paths

Desired result:
- `internal` payloads cannot be delivered
- `summary-only` payloads cannot be direct-sent as user-visible text
- legacy prompt-only deferred items are rejected during migration cleanup

### Task 5 — Remove legacy prompt-based rendering and add regressions
Required cleanup:
- remove `item.prompt` render usage from deferred drains
- remove legacy deferred prompt fields where safe
- add regression coverage for boundary leaks

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
