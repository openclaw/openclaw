# Phase 2: Runtime Governance Enforcement - Research

**Researched:** 2026-03-08  
**Domain:** OpenClaw runtime hooks, guardrails enforcement, diagnostics telemetry  
**Confidence:** HIGH

---

## Summary

Phase 2 should convert Phase 1 governance doctrine into runtime enforcement, not just prompt guidance. The codebase already has strong primitives for this:

1. **Policy interception before tools run** via `before_tool_call` and wrapper logic in `src/agents/pi-tools.before-tool-call.ts`.
2. **Session-write interception** via synchronous `before_message_write` and `tool_result_persist` hooks in `src/plugins/hooks.ts` and `src/agents/session-tool-result-guard-wrapper.ts`.
3. **Structured telemetry bus** via `emitDiagnosticEvent` in `src/infra/diagnostic-events.ts`, with OTEL export support in `extensions/diagnostics-otel/src/service.ts`.

Primary recommendation: implement a dedicated governance enforcement layer in two waves:

- **Wave 1:** deterministic permit/prohibit/escalate decisions at tool-call time with machine-readable policy.
- **Wave 2:** compliance telemetry and operational rollout (shadow mode -> enforce mode), plus human verification.

---

## Existing Enforcement Primitives

### 1) Tool-call interception is already in the hot path

- `src/agents/pi-tools.before-tool-call.ts` wraps tools and runs hook-based checks before execution.
- The hook contract supports:
  - parameter rewrite (`params`)
  - hard block (`block: true`)
  - block reason (`blockReason`)
- This is the most direct place to enforce constitutional restrictions on mutating operations.

### 2) Post-tool observability exists

- `src/agents/pi-embedded-subscribe.handlers.tools.ts` emits tool lifecycle start/update/result events and runs `after_tool_call`.
- This can feed explainability and audit traces for constitutional decisions.

### 3) Transcript persistence is guardable

- `src/agents/session-tool-result-guard-wrapper.ts` and `src/plugins/hooks.ts` provide synchronous hooks before transcript writes.
- This supports memory-governance controls (for example, dropping unsafe synthetic payloads or enforcing metadata tagging).

### 4) Diagnostics infrastructure is extensible

- `src/infra/diagnostic-events.ts` defines typed diagnostic events.
- `src/logging/diagnostic.ts` already emits structured events (message flow, queue, session, tool loop).
- `extensions/diagnostics-otel/src/service.ts` consumes these events and exports OTEL metrics/spans.
- This is the right place for compliance telemetry (`permit`, `prohibit`, `escalate`).

### 5) Plugin runtime is suitable for governance packaging

- Plugin hooks and lifecycle are first-class (`src/plugins/types.ts`, `src/plugins/hooks.ts`).
- Bundled extension pattern is established (`extensions/*`, `openclaw.plugin.json`, in-package tests).
- Phase 2 can ship as a governance extension while keeping core changes focused on shared telemetry/runtime surfaces.

---

## Key Gaps to Close in Phase 2

1. No machine-readable governance runtime policy currently exists.
2. No standard decision result schema (`PERMIT/PROHIBIT/ESCALATE`) in runtime.
3. No dedicated diagnostic event type for governance enforcement outcomes.
4. No operator-facing rollout model (shadow mode before hard enforcement).
5. No explicit validation suite for constitutional decision paths in tool workflows.

---

## Recommended Phase 2 Architecture

## A) Runtime policy artifact

Create a machine-readable policy derived from Phase 1 constitutional docs, with:

- scope (tools/actions/paths)
- decision (`permit`, `prohibit`, `escalate`)
- reason code
- escalation target/requirements
- policy version

This avoids brittle natural-language parsing at runtime.

## B) Governance enforcement extension

Create a bundled extension (`extensions/frankos-governance`) that:

- evaluates every mutating tool call against runtime policy
- blocks prohibited actions deterministically
- blocks-and-prompts escalation-required actions in enforce mode
- supports `off | shadow | enforce` mode for safe rollout

## C) Compliance telemetry

Add a typed diagnostic event (`governance.decision`) and OTEL mapping so each governed decision is observable:

- run/session context
- tool + action fingerprint
- decision outcome
- reason code
- enforcement mode
- latency

## D) Operational wiring

Ensure governance policy is loaded in runtime bootstrap contexts and docs:

- boot memory references runtime policy artifact
- CLAUDE/project runtime docs mention evaluation mode and hierarchy
- local config enables plugin in shadow mode first

---

## Implementation Risks and Mitigations

1. **Risk:** fail-open behavior on plugin runtime errors.
   - **Mitigation:** enforce-mode path must treat policy-load/evaluation failure as escalation block, not silent allow.

2. **Risk:** over-blocking breaks productivity.
   - **Mitigation:** start in `shadow` mode, record deltas, then tighten rules with measured false-positive review.

3. **Risk:** policy drift between Phase 1 docs and runtime policy JSON.
   - **Mitigation:** include version and source refs in runtime policy; require update checklist in Phase 2 verification.

4. **Risk:** telemetry blind spots.
   - **Mitigation:** add typed diagnostic event and ensure OTEL service handles it explicitly.

---

## Open Questions

1. Which mutating tools should be in strict scope initially (minimum set vs. full coverage)?
2. Should escalation approvals be owner-only by default, or per-channel role aware?
3. Should governance decisions be visible in end-user replies or only in logs/events?
4. Should policy distribution be vault-local only, or also mirrored into repo fixtures for tests?

---

## Recommendations for Phase 2 Planning

1. Split work into two execution plans:
   - Plan 02-01: policy + enforcement engine
   - Plan 02-02: telemetry + rollout + human verification
2. Keep policy runtime format strict and versioned from day one.
3. Require scenario-based tests for permit/prohibit/escalate across tool classes.
4. Gate final approval on shadow-mode evidence, not only unit tests.

---

## Sources (Codebase)

- `src/agents/pi-tools.before-tool-call.ts`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts`
- `src/agents/session-tool-result-guard-wrapper.ts`
- `src/plugins/hooks.ts`
- `src/plugins/types.ts`
- `src/plugins/runtime/types-core.ts`
- `src/plugins/runtime/runtime-events.ts`
- `src/infra/diagnostic-events.ts`
- `src/logging/diagnostic.ts`
- `extensions/diagnostics-otel/src/service.ts`
- `docs/concepts/agent-loop.md`
- `docs/tools/plugin.md`

---

## Metadata

**Confidence breakdown:**

- Hook interception capabilities: HIGH
- Telemetry extension points: HIGH
- Runtime packaging path (extension model): HIGH
- Rollout risk estimation: MEDIUM (depends on policy strictness choices)

**Research date:** 2026-03-08  
**Valid until:** 2026-04-08
