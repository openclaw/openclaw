---
summary: "Plan: isolate browser act:evaluate from Playwright queue using CDP, with end-to-end deadlines and safer ref resolution"
read_when:
  - Working on browser `act:evaluate` timeout, abort, or queue blocking issues
  - Planning CDP based isolation for evaluate execution
owner: "openclaw"
status: "draft"
last_updated: "2026-02-10"
title: "Browser Evaluate CDP Refactor"
---

# Browser Evaluate CDP Refactor Plan

## Context

`act:evaluate` executes user provided JavaScript in the page. Today it runs via Playwright
(`page.evaluate` or `locator.evaluate`). Playwright serializes CDP commands per page, so a
stuck or long running evaluate can block the page command queue and make every later action
on that tab look "stuck".

PR #13498 adds a pragmatic safety net (bounded evaluate, abort propagation, and best-effort
recovery). This document describes a larger refactor that makes `act:evaluate` inherently
isolated from Playwright so a stuck evaluate cannot wedge normal Playwright operations.

## Goals

- `act:evaluate` cannot permanently block later browser actions on the same tab.
- Timeouts are single source of truth end to end so a caller can rely on a budget.
- Abort and timeout are treated the same way across HTTP and in-process dispatch.
- Element targeting for evaluate is supported without switching everything off Playwright.
- Maintain backward compatibility for existing callers and payloads.

## Non-goals

- Replace all browser actions (click, type, wait, etc.) with CDP implementations.
- Remove the existing safety net introduced in PR #13498 (it remains a useful fallback).
- Introduce new unsafe capabilities beyond the existing `browser.evaluateEnabled` gate.
- Add process isolation (worker process/thread) for evaluate. If we still see hard to recover
  stuck states after this refactor, that is a follow-up idea.

## Current Architecture (Why It Gets Stuck)

At a high level:

- Callers send `act:evaluate` to the browser control service.
- The route handler calls into Playwright to execute the JavaScript.
- Playwright serializes page commands, so an evaluate that never finishes blocks the queue.
- A stuck queue means later click/type/wait operations on the tab can appear to hang.

## Proposed Architecture

### 1. Deadline Propagation

Introduce a single budget concept and derive everything from it:

- Caller sets `timeoutMs` (or a deadline in the future).
- The outer request timeout, route handler logic, and the execution budget inside the page
  all use the same budget, with small headroom where needed for serialization overhead.
- Abort is propagated as an `AbortSignal` everywhere so cancellation is consistent.

Implementation direction:

- Add a small helper (for example `createBudget({ timeoutMs, signal })`) that returns:
  - `signal`: the linked AbortSignal
  - `deadlineAtMs`: absolute deadline
  - `remainingMs()`: remaining budget for child operations
- Use this helper in:
  - `src/browser/client-fetch.ts` (HTTP and in-process dispatch)
  - `src/node-host/runner.ts` (proxy path)
  - browser action implementations (Playwright and CDP)

### 2. Separate Evaluate Engine (CDP Path)

Add a CDP based evaluate implementation that does not share Playwright's per page command
queue. The key property is that the evaluate transport is a separate WebSocket connection
and a separate CDP session attached to the target.

Implementation direction:

- New module, for example `src/browser/cdp-evaluate.ts`, that:
  - Connects to the configured CDP endpoint (browser level socket).
  - Uses `Target.attachToTarget({ targetId, flatten: true })` to get a `sessionId`.
  - Runs either:
    - `Runtime.evaluate` for page level evaluate, or
    - `DOM.resolveNode` plus `Runtime.callFunctionOn` for element evaluate.
  - On timeout or abort:
    - Sends `Runtime.terminateExecution` best-effort for the session.
    - Closes the WebSocket and returns a clear error.

Notes:

- This still executes JavaScript in the page, so termination can have side effects. The win
  is that it does not wedge the Playwright queue, and it is cancelable at the transport
  layer by killing the CDP session.

### 3. Ref Story (Element Targeting Without A Full Rewrite)

The hard part is element targeting. CDP needs a DOM handle or `backendDOMNodeId`, while
today most browser actions use Playwright locators based on refs from snapshots.

Recommended approach: keep existing refs, but attach an optional CDP resolvable id.

#### 3.1 Extend Stored Ref Info

Extend the stored role ref metadata to optionally include a CDP id:

- Today: `{ role, name, nth }`
- Proposed: `{ role, name, nth, backendDOMNodeId?: number }`

This keeps all existing Playwright based actions working and allows CDP evaluate to accept
the same `ref` value when the `backendDOMNodeId` is available.

#### 3.2 Populate backendDOMNodeId At Snapshot Time

When producing a role snapshot:

1. Generate the existing role ref map as today (role, name, nth).
2. Fetch the AX tree via CDP (`Accessibility.getFullAXTree`) and compute a parallel map of
   `(role, name, nth) -> backendDOMNodeId` using the same duplicate handling rules.
3. Merge the id back into the stored ref info for the current tab.

If mapping fails for a ref, leave `backendDOMNodeId` undefined. This makes the feature
best-effort and safe to roll out.

#### 3.3 Evaluate Behavior With Ref

In `act:evaluate`:

- If `ref` is present and has `backendDOMNodeId`, run element evaluate via CDP.
- If `ref` is present but has no `backendDOMNodeId`, fall back to the Playwright path (with
  the safety net).

Optional escape hatch:

- Extend the request shape to accept `backendDOMNodeId` directly for advanced callers (and
  for debugging), while keeping `ref` as the primary interface.

### 4. Keep A Last Resort Recovery Path

Even with CDP evaluate, there are other ways to wedge a tab or a connection. Keep the
existing recovery mechanisms (terminate execution + disconnect Playwright) as a last resort
for:

- legacy callers
- environments where CDP attach is blocked
- unexpected Playwright edge cases

## Implementation Plan (Single Iteration)

### Deliverables

- A CDP based evaluate engine that runs outside the Playwright per-page command queue.
- A single end-to-end timeout/abort budget used consistently by callers and handlers.
- Ref metadata that can optionally carry `backendDOMNodeId` for element evaluate.
- `act:evaluate` prefers the CDP engine when possible and falls back to Playwright when not.
- Tests that prove a stuck evaluate does not wedge later actions.
- Logs/metrics that make failures and fallbacks visible.

### Implementation Checklist

1. Add a shared "budget" helper to link `timeoutMs` + upstream `AbortSignal` into:
   - a single `AbortSignal`
   - an absolute deadline
   - a `remainingMs()` helper for downstream operations
2. Update all caller paths to use that helper so `timeoutMs` means the same thing everywhere:
   - `src/browser/client-fetch.ts` (HTTP and in-process dispatch)
   - `src/node-host/runner.ts` (node proxy path)
   - CLI wrappers that call `/act` (add `--timeout-ms` to `browser evaluate`)
3. Implement `src/browser/cdp-evaluate.ts`:
   - connect to the browser-level CDP socket
   - `Target.attachToTarget` to get a `sessionId`
   - run `Runtime.evaluate` for page evaluate
   - run `DOM.resolveNode` + `Runtime.callFunctionOn` for element evaluate
   - on timeout/abort: best-effort `Runtime.terminateExecution` then close the socket
4. Extend stored role ref metadata to optionally include `backendDOMNodeId`:
   - keep existing `{ role, name, nth }` behavior for Playwright actions
   - add `backendDOMNodeId?: number` for CDP element targeting
5. Populate `backendDOMNodeId` during snapshot creation (best-effort):
   - fetch AX tree via CDP (`Accessibility.getFullAXTree`)
   - compute `(role, name, nth) -> backendDOMNodeId` and merge into the stored ref map
   - if mapping is ambiguous or missing, leave the id undefined
6. Update `act:evaluate` routing:
   - if no `ref`: always use CDP evaluate
   - if `ref` resolves to a `backendDOMNodeId`: use CDP element evaluate
   - otherwise: fall back to Playwright evaluate (still bounded and abortable)
7. Keep the existing "last resort" recovery path as a fallback, not the default path.
8. Add tests:
   - stuck evaluate times out within budget and the next click/type succeeds
   - abort cancels evaluate (client disconnect or timeout) and unblocks subsequent actions
   - mapping failures cleanly fall back to Playwright
9. Add observability:
   - evaluate duration and timeout counters
   - terminateExecution usage
   - fallback rate (CDP -> Playwright) and reasons

### Acceptance Criteria

- A deliberately hung `act:evaluate` returns within the caller budget and does not wedge the
  tab for later actions.
- `timeoutMs` behaves consistently across CLI, agent tool, node proxy, and in-process calls.
- If `ref` can be mapped to `backendDOMNodeId`, element evaluate uses CDP; otherwise the
  fallback path is still bounded and recoverable.

## Testing Plan

- Unit tests:
  - `(role, name, nth)` matching logic between role refs and AX tree nodes.
  - Budget helper behavior (headroom, remaining time math).
- Integration tests:
  - CDP evaluate timeout returns within budget and does not block the next action.
  - Abort cancels evaluate and triggers termination best-effort.
- Contract tests:
  - Ensure `BrowserActRequest` and `BrowserActResponse` remain compatible.

## Risks And Mitigations

- Mapping is imperfect:
  - Mitigation: best-effort mapping, fallback to Playwright evaluate, and add debug tooling.
- `Runtime.terminateExecution` has side effects:
  - Mitigation: only use on timeout/abort and document the behavior in errors.
- Extra overhead:
  - Mitigation: only fetch AX tree when snapshots are requested, cache per target, and keep
    CDP session short lived.
- Extension relay limitations:
  - Mitigation: use browser level attach APIs when per page sockets are not available, and
    keep the current Playwright path as fallback.

## Open Questions

- Should the new engine be configurable as `playwright`, `cdp`, or `auto`?
- Do we want to expose a new "nodeRef" format for advanced users, or keep `ref` only?
- How should frame snapshots and selector scoped snapshots participate in AX mapping?
