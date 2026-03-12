# Technical Plan: Zulip Plugin Hardening Pass

**Status:** Approved
**Date:** 2026-03-11
**Flow/Context Builder Output:** Repo-grounded planning pass across the current Zulip plugin, shared approval/model command paths, and the Lionroot Zulip strategy docs. The code already ships the core primitives; the next pass should harden state ownership and productize the existing UX rather than add major new transport capability. Bryan approved proceeding with this plan in the Codex session on 2026-03-11 by replying "both" after the draft workflow artifacts were presented.

## Architecture

The work stays primarily inside `extensions/zulip/src/zulip/` and uses the current seams instead of introducing a new framework:

- `components-registry.ts` becomes the durable owner of button callback state.
- `send-components.ts` registers persisted widget state and carries callback expiry metadata.
- `monitor.ts` switches from resolve/remove to claim/consume semantics, hosts thin local command handling, and runs startup audits.
- `exec-approvals.ts` keeps owning approval delivery and resolution, but gains persisted pending state.
- `model-picker.ts` keeps owning provider/model rendering and callback decoding, but gains invoker ACL scoping.
- `topic-bindings.ts` stays the lifecycle foundation; only targeted rebind work is added if live event validation proves it safe.

## Files to Modify

- `extensions/zulip/src/zulip/components-registry.ts` — replace in-memory-only registry with durable per-account registry and message-scope consumption helpers.
- `extensions/zulip/src/zulip/send-components.ts` — register durable widget entries and pass optional callback expiry metadata.
- `extensions/zulip/src/zulip/components.ts` — normalize `allowedUsers` and `allowed_users` for Zulip component payloads.
- `extensions/zulip/src/zulip/exec-approvals.ts` — persist pending approval prompts, rehydrate timers, retire widget entries by message.
- `extensions/zulip/src/zulip/model-picker.ts` — preserve button ACL metadata and add invoker-scoped builder params.
- `extensions/zulip/src/zulip/commands.ts` — new thin Zulip-local command parser/handler for transport-owned UX.
- `extensions/zulip/src/zulip/monitor.ts` — adopt registry claim flow, insert local command handling, run stale-click DM behavior, run startup audit, and host topic rebind integration if validated.
- `extensions/zulip/src/zulip/topic-bindings.ts` — add targeted rebind helper only if live topic-edit events support it.
- `extensions/zulip/src/zulip/resolve-users.ts` — add outbound-only fuzzy/suggestion helper while preserving strict auth resolution.
- `extensions/zulip/src/zulip/send.ts` — use clearer outbound resolution errors and optional fuzzy helper.
- `extensions/zulip/src/zulip/client.ts` — only if needed to surface topic-edit event typing or registration.
- `../lionroot-openclaw/docs/zulip-upgrade-plan.md` — refresh the roadmap to match shipped reality and the new execution order.

## New Files

- `extensions/zulip/src/zulip/commands.ts` — minimal transport-owned Zulip command layer for `/models` and, only if validation proves necessary, `/approve` fallback handling.

## Tasks

1. [ ] Refresh the Zulip upgrade doc so planning truth matches the shipped code.
2. [ ] Implement a durable per-account component registry with claim semantics and message-scope consumption for non-reusable widgets.
3. [ ] Update send + monitor flows to use the new registry API, including stale-click handling.
4. [ ] Persist pending Zulip exec approvals and rehydrate them on startup.
5. [ ] Thread `allowedUsers` through model-picker rendering and scope picker controls to the invoker.
6. [ ] Add a thin Zulip-local command layer for `/models`; validate and reuse shared `/approve` unless testing proves a local fallback is necessary.
7. [ ] Validate live topic-edit event fidelity; if safe, add targeted topic rebinding, otherwise stop short and document the manual fallback path.
8. [ ] Add outbound resolution polish and a warn-only startup audit for configured streams, approval targets, analysis streams, and approver identities.
9. [ ] Add focused tests for registry durability, approval recovery, model-picker ACL behavior, local command entry, and any topic rebinding logic that lands.
10. [ ] Run targeted Zulip tests and a review pass before asking for approval to implement.

## Detailed File Plan

### 1) `extensions/zulip/src/zulip/components-registry.ts`

Replace the current global in-memory helpers with a registry manager that owns:

- in-memory `entriesById`
- per-account store path
- serialized persistence queue
- expiry pruning
- message-scope consumption helpers

Add types roughly shaped like:

- `StoredZulipComponentEntry`
- `ZulipComponentClaimResult`
- `StoredZulipComponentRegistryFile`

Add or replace APIs with:

- `registerEntries(...)`
- `claimEntry(...)`
- `consumeMessageEntries(messageId)`
- `removeMessageEntries(messageId)`
- `pruneExpired(now?)`
- per-account loader/manager getter

Behavioral requirement:

- For non-reusable widgets, a successful click retires the entire widget message, not just the clicked button.
- Unauthorized clicks must not consume the widget.
- Expired/missing/consumed claims must be distinguishable so `monitor.ts` can DM the clicker with a stale-action notice.

### 2) `extensions/zulip/src/zulip/send-components.ts`

Update the high-level send path to:

- register entries through the durable registry manager
- pass message ID into registry registration
- optionally accept `callbackExpiresAtMs?: number`
- align approval widget TTL with approval expiry when supplied

The existing text degradation path stays intact.

### 3) `extensions/zulip/src/zulip/components.ts`

Extend spec parsing so Zulip payload round trips preserve ACL metadata.

Required changes:

- normalize both `allowedUsers` and `allowed_users`
- preserve existing `callbackData` / `callback_data` handling
- keep button schema limited and explicit

### 4) `extensions/zulip/src/zulip/exec-approvals.ts`

Keep `ZulipExecApprovalHandler` as the owner, but add a persisted pending approval store.

Add stored record state for:

- approval ID
- prompt message IDs + targets
- expiry timestamp
- cleanup mode

Required behavior:

- on `start()`, load persisted approvals, reschedule timers, and immediately expire stale ones
- on request, persist prompt metadata after sends succeed
- on resolve/timeout, update prompt messages, retire widget entries by message ID, and remove persisted state
- use `callbackExpiresAtMs` so approval widgets expire with the approval request

### 5) `extensions/zulip/src/zulip/model-picker.ts`

Productize the already-shipped picker instead of redesigning it.

Required changes:

- add `allowedUserIds?: number[]` to public builder params
- preserve `allowedUsers` when converting picker render state into Zulip reply payloads
- ensure render-on-click flows keep the same ACL on the next picker page
- keep picker pages disposable rather than reusable

Do not add a separate picker store in phase 1.

### 6) `extensions/zulip/src/zulip/commands.ts` (new)

Keep this intentionally small.

Responsibilities:

- parse a minimal Zulip-local command set
- own transport rendering/affordance for `/models`
- validate whether shared `/approve` is already sufficient
- only add local `/approve` handling if end-to-end validation proves the shared path inadequate in Zulip

Suggested initial union:

- `{ kind: "models" }`
- `{ kind: "approve"; approvalId: string; decision: ExecApprovalDecision }`

### 7) `extensions/zulip/src/zulip/monitor.ts`

This is the orchestration point and gets the biggest integration change.

Required updates:

- load the durable component registry for the active account on startup
- replace resolve+remove callback flow with `claimEntry(...)`
- on `missing|expired|consumed`, DM the clicker with a stale-action notice
- on `unauthorized`, log and stop without consuming
- consume widget state at message scope after successful non-reusable clicks
- insert thin local command handling after xcase handling and before generic agent execution
- run warn-only startup audit for streams/approval targets/approvers
- if topic-edit event validation succeeds, host the rebind flow here

### 8) `extensions/zulip/src/zulip/topic-bindings.ts`

Do not rebuild this system.

Only add targeted lifecycle support if validation proves automatic rename handling is safe:

- `rebindConversation(...)`

If the live Zulip event stream is insufficient, document the stop condition and leave automatic rebinding out of scope for this pass.

### 9) `extensions/zulip/src/zulip/resolve-users.ts` and `send.ts`

Polish outbound ergonomics without weakening authorization semantics.

- exact match first
- then single-candidate fuzzy suggestion/match for outbound sends only
- fail clearly on ambiguous results
- keep allowlist, approver, and auth-sensitive identity checks strict

### 10) `../lionroot-openclaw/docs/zulip-upgrade-plan.md`

Update the roadmap after the code-grounded pass so it:

- marks exec approvals and model picker as already shipped but rough
- promotes interaction durability to the top priority
- frames the next Zulip pass as plugin hardening/productization
- defers fork growth until real usage proves it necessary

## Testing Strategy

Add focused, colocated tests near the touched Zulip files.

Minimum test coverage:

- component registry persistence/load/expiry/claim behavior
- message-scope consumption for multi-button widgets
- stale-click and unauthorized-click handling
- exec approval restart recovery and prompt update behavior
- model picker ACL preservation and invoker scoping
- `/models` local command handling with widgets enabled/disabled
- shared `/approve` Zulip path validation or local fallback tests if implemented
- topic rebind tests only if automatic rebinding actually lands

Recommended execution checks:

- targeted Zulip Vitest suites for touched files
- at least one broader typecheck/build pass before review

## Rollback Plan

- Reverting the registry changes falls back to today’s in-memory widget behavior.
- Reverting approval persistence falls back to today’s non-durable approval prompts.
- Reverting picker ACL work removes scoping but preserves the existing picker behavior.
- Reverting the local command layer still leaves shared text commands available.
- Topic rebind logic, if added, should be isolated so it can be reverted without affecting the existing binding manager.
- Docs update can be reverted independently from code.

## Risks and Validation Gates

- **Shared `/approve` status is known but must still be validated end to end in Zulip.** The shared handler exists in `src/auto-reply/reply/commands-approve.ts`; do not duplicate it unless a real Zulip gap is proven.
- **Automatic topic rebinding must be gated on live event fidelity.** Do not implement heuristic rename matching.
- **Persistence assumes one active monitor process per Zulip account.** If deployment moves multi-process later, these stores may need a shared backend.
- **Startup audit must remain warn-only.** It should clarify operator issues without blocking the monitor from connecting.

## Implementation Order

1. Docs refresh in workflow + roadmap
2. Durable component registry
3. Monitor/send integration for claim + stale-click handling
4. Exec approval durability
5. Model picker ACL/scoping
6. Thin Zulip-local `/models` command handling
7. Topic event validation and conditional rebind work
8. Resolution polish + startup audit
9. Tests + review
