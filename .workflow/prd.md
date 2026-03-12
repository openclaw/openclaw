# PRD: Zulip Plugin Hardening Pass

**Status:** Approved
**Date:** 2026-03-11
**Provenance:** See `inputs/original-request.md` and `inputs/references.md`. Bryan approved proceeding with this PRD in the Codex session on 2026-03-11 by replying "both" after the draft workflow artifacts were presented.

## Summary

Harden the existing Zulip plugin UX in `extensions/zulip` so the features that are already shipped behave reliably in real use. This pass is not about adding major new Zulip primitives or broadening the fork. It is a plugin-first reliability and productization pass focused on durable callback state, restart-safe exec approvals, invoker-scoped model picker flows, thin Zulip-native command affordances, topic lifecycle validation/rebinding, and warn-only startup audits.

## User Stories

- As a Zulip user, I want approval and picker buttons to keep working after a monitor restart so the transport feels dependable.
- As an approver, I want exec approval prompts to survive restart and retire correctly after resolution or expiry.
- As a user, I want model picker controls scoped to me so other people in the stream cannot hijack my selection flow.
- As an operator, I want `/models` to feel like a first-class Zulip control without duplicating the shared command system unnecessarily.
- As an operator, I want topic-bound sessions to stay stable across normal lifecycle events and fail safely when rename/rebind cannot be trusted.
- As a maintainer, I want the Zulip upgrade docs to match shipped reality so future planning is grounded in what already exists.

## Acceptance Criteria

### Docs and planning truth

- [ ] `lionroot-openclaw/docs/zulip-upgrade-plan.md` is updated to reflect that exec approvals and model picker are already shipped but need hardening/productization.
- [ ] The document ranks durable interaction state as the top plugin priority.
- [ ] The document no longer frames the next pass as mainly new capability work.

### Durable component registry

- [ ] Zulip component callback state is persisted per account to disk.
- [ ] Restarting the Zulip monitor preserves unexpired widget callbacks.
- [ ] Callback claiming distinguishes `ok`, `unauthorized`, `missing`, `expired`, and `consumed` outcomes.
- [ ] Non-reusable widgets are retired at message scope, not just button scope.
- [ ] Stale/expired/consumed clicks notify the clicker privately rather than spamming the originating stream.

### Exec approval durability

- [ ] Pending Zulip approval prompt state is persisted per account.
- [ ] On startup, the handler rehydrates pending approvals and timeout jobs.
- [ ] On resolve or timeout after restart, previously-sent approval prompt messages are still updated.
- [ ] Approval widget entries are retired by message ID on resolve/expiry.

### Model picker productization

- [ ] `allowedUsers` survives the Zulip reply payload round trip.
- [ ] Picker buttons are scoped to the invoking user.
- [ ] Old picker pages are disposable and retired after click.
- [ ] Unauthorized picker clicks are ignored/logged without consuming the control.

### Thin Zulip-local command UX

- [ ] Zulip gets a thin transport-owned `/models` entry point that renders widget UX when widgets are enabled.
- [ ] When widgets are disabled, `/models` falls back cleanly to the existing shared text path.
- [ ] The shared `/approve` path is validated end to end in Zulip before any local duplication is added.
- [ ] If shared `/approve` is insufficient in practice, a minimal local fallback is added and documented.

### Topic lifecycle and audit

- [ ] Existing persisted topic bindings remain intact.
- [ ] Live Zulip topic-edit event fidelity is validated before any automatic rebind logic is implemented.
- [ ] If automatic rename/rebind is viable, a targeted binding migration path is added.
- [ ] If it is not viable, the plan explicitly stops short of heuristic rebinding.
- [ ] Startup audit runs once, remains warn-only, and checks configured streams, analysis streams, approval targets, and approver identities.

### Resolution polish

- [ ] Outbound-only fuzzy/suggestion behavior improves ambiguous user/stream sends.
- [ ] Allowlist and approval authorization resolution remain strict.
- [ ] Ambiguous and not-found outbound errors are clearer than they are today.

## Out of Scope

- New Zulip fork primitives such as dropdowns, modal forms, or rich cards.
- A broad shared cross-channel interaction framework.
- A generic shared command-system refactor.
- Rewriting `monitor.ts` wholesale.
- XCase expansion or unrelated Zulip feature work.
- Reworking draft streaming, which is already shipped.

## Technical Notes

- Keep the work in `extensions/zulip` unless a validated blocker truly requires fork work.
- Reuse the current seams: `components-registry.ts`, `send-components.ts`, `exec-approvals.ts`, `model-picker.ts`, `monitor.ts`, and `topic-bindings.ts`.
- Preserve existing shared command behavior where it already works, especially `/approve`.
- Use the same Zulip state area pattern already used by `topic-bindings.ts` for new persisted state.
- Startup audit should be non-blocking and warn-only on the first pass.
- Do not add new config knobs unless field use clearly proves they are needed.
