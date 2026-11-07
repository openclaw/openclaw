# Provider-review reconciliation: recovery contract proposal

Status: **RFC. No working recovery implementation.** Based on merged prevention
PR [#179054](https://github.com/openclaw/openclaw/pull/179054), commit
`e501abf29b6ac219df5196cc44fcfaf9f7bec12c`.

## Problem and intended behavior

A failed acknowledgment can leave an existing OpenClaw conversation bound to
native thread B while its genuine pending review identifies native thread A and
failed turn T. The unchanged normal review validator correctly rejects B. The
prevention fix preserves bindings on future failures but cannot reconcile this
existing mismatch.

An owner should be able to request a supported state reconciliation that proves
the current authority to reattach A, restores the conversation link through its
canonical owner, and leaves the exact review pending. The owner then separately
uses the normal review dialog to acknowledge. Reconciliation must not grant
continuation, submit input, replay queued messages, or create a substitute thread.

## Existing evidence and missing capabilities

The genuine review and runtime records can establish historical session/thread/
failed-turn association. The managed-thread inventory is advisory home/thread
membership; neither it nor saved metadata proves a current physical subscription
or effective configuration. A recorded failed status does not authorize removing
a retained writer identity. The live ownership coordinator must reconcile it.

Existing OpenClaw native queues, host session authority, binding leases/CAS,
metadata parser, adoption checks, app/MCP attestation and review validator must
remain the owners of their respective invariants. There is no implemented
review-scoped operation combining them to restore a previously replaced binding.

Two OpenClaw capabilities are required:

1. **Native reconciliation broker.** Obtain genuine live native ownership and
   effective configuration observations for the review-derived original thread,
   its immutable catalog and currently authorized executors. Historical metadata,
   request parameters, client flags and TypeScript brands cannot mint this proof.
2. **Review-scoped canonical coordinator.** Fence the unchanged session/review,
   both native identities and the complete current binding preimage; reconcile
   through the canonical binding owner; persist operation disposition for
   idempotence and uncertain outcomes. It must not modify the review store or
   issue/consume an acknowledgment capability.

The required interfaces are declared in
`extensions/codex/src/app-server/provider-review-recovery.contract.d.ts`.
They deliberately have no runtime issuer, broker, coordinator or endpoint.

## OpenClaw versus provider responsibility

Codex [0.160.0 ThreadResumeResponse](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L436)
already includes approval policy, approvals reviewer, sandbox, active permission
profile and runtime workspace roots. The inspected OpenClaw
[resume response type](https://github.com/openclaw/openclaw/blob/e501abf29b6ac219df5196cc44fcfaf9f7bec12c/extensions/codex/src/app-server/protocol.ts#L170)
retains a narrower shape. Extending protocol parsing and comparing the effective
fields to the current trusted policy plan is repository work. The supporting
`compareRecoveryPolicyObservation` demonstrates only that data comparison. It
always reports `mutationAuthorized: false` and explicitly lists guarantees it
does not establish. Unknown permission-profile provenance refuses comparison.

**Dependency D1 is unresolved:** establish a native guarantee that the observed
effective configuration and subscription belong to the selected physical client
and remain current through canonical commit. OpenClaw's existing
[configuration observation](https://github.com/openclaw/openclaw/blob/e501abf29b6ac219df5196cc44fcfaf9f7bec12c/extensions/codex/src/app-server/thread-lifecycle-adoption.ts#L303)
observes native teardown but explicitly does not reserve against native reloads.
Its startup route reservation buffers/routes notifications; that is not proof of
a provider-side exclusive configuration generation. Native resume also may
acknowledge ignored overrides on a loaded thread.

Native maintainers must verify whether the existing cold-resume, close receipt,
effective response and current owned-client checks suffice for the narrowly
scoped OpenClaw-owned local home. If they do, implement the broker with those
existing operations and prove the contract using the real isolated app-server.
If they do not, an atomic/current native ownership/configuration capability must
be supplied by Codex. OpenClaw cannot create that provider guarantee by hashing
requested settings or trusting persisted flags. Until D1 is resolved, the broker
must return `unavailable`. This RFC does not assert that a provider change is
already proven necessary or that an existing native RPC supplies such a token.

## Proposed operation and implementation map

Proposed, **unimplemented**, wire method:
`sessions.providerReview.reconcile`. Accept only session key/agent/session ID,
review ID, operation ID and an expected canonical binding revision. Never accept
a target native thread, owner identity, catalog, policy or acknowledgment from
the client. Derive A and T only from the genuine pending review.

Require a real authenticated operator UI, owner or `operator.admin` permission
as appropriate for native binding control, and current session mutation authority.
Reject synthetic/sender-attributed clients. A repair is scoped to the original
conversation and retains the current operator identity; it does not impersonate
the original channel sender.

Planned repository owners:

| Owner | Required work |
| --- | --- |
| Gateway protocol schema/method descriptors; `src/gateway/server-methods/sessions-provider-review.ts` | Add separate owner-authorized reconciliation method, strict parameters and result states; no automatic continuation. |
| Host session mutation coordinator and `src/sessions/provider-review.ts` integration | Capture review/session lifecycle authority without reusing an acknowledgment as repair permission; fence simultaneous acknowledgment and review mutation. |
| New `provider-review-recovery.ts` plus `thread-ownership.ts`, `thread-lifecycle-adoption.ts`, `thread-lifecycle-io.ts` | Implement D1 broker, ownership acquisition and verified native handoff; forbid fresh-thread fallback and any model/input submission. |
| `native-tool-catalog.ts` and current tool-policy preparation owner | Introduce a genuinely issued review-recovery observation path; preserve ordinary scope and all metadata/path/home checks. Never fake supervision scope. |
| `protocol.ts` and protocol response validators | Retain/validate effective native policy fields. A matching JSON response alone is insufficient authority. |
| `session-binding.ts` and canonical native session lifecycle | Conditional reconciliation against full binding/client/policy/generation preimage, not only thread ID; preserve pending review; persist idempotent disposition through existing state owners. |
| Control UI review controller | Display reconciliation result separately from normal acknowledgment; keep queued input held. |

The host and plugin stores are distinct owners. Do not assume one SQLite write
atomically fences both. Use the existing host lifecycle admission and binding
owner under a coordinator whose authority remains current at canonical commit.
Audit lock ordering and native ownership across both A and B; do not introduce
an inverse acquisition order relative to ordinary binding/lifecycle operations.

## Recovery phases and catalog compatibility

1. **Inspect and capture.** Capture the real owner/session/review authority and
   complete current binding revision. Prove B belongs to the failed acknowledgment
   and has no accepted input or consequential work. Absence of a rollout file or
   diagnostic prompt event alone is not this proof. Any ambiguous B outcome stops
   recovery; preserve both histories.
2. **Prepare under current authority.** Resolve the original managed native home,
   acquire canonical/exclusive ownership, reconcile any retained writer through
   its real owner, verify idle/direct-input eligibility, exact A/T/latest failure
   and findings, original catalog provenance and current native/configuration
   policy. Obtain D1 observation. Do not append history, inject instructions,
   start/fork a thread, or submit a model/tool turn during reconciliation. If
   required policy changes cannot be applied and attested without those actions,
   report unavailable instead of calling the normal run path opportunistically.
3. **Reconcile canonically.** Recheck all generations and the complete binding
   preimage under host/native fences. Commit A only through the canonical binding
   owner, using freshly validated fields. Leave review R byte-for-byte identical
   and pending. Record operation disposition, not review acceptance. Return
   `consistent`, `reviewStillPending: true`, `continuationApproved: false`.
4. **Separate acknowledgment.** Only a later explicit normal UI acknowledgment
   may invoke `sessions.providerReview.continue`. Keep its thread, latest failed
   turn, findings, runtime/model, caller and provider-acceptance checks unchanged.
   Revalidate current policy/ownership; recovery receipts do not grant execution.

The original native declarations may expose 43 functions while operator UI
preparation exposes 61. Do not make counts equal by truncating tools, reverting
policy, replaying old instructions or changing channel identity. Under a genuine
fresh recovery/review observation, prepare the **exact original native catalog**
as immutable data and map every declaration to a currently authorized,
schema-compatible executor through the existing tool-policy owner. This uses
the same separation between catalog data and executor authority as verified
native catalog preparation, without inventing a supervision binding. If that
mapping or any current MCP/app/skills/network/native policy is incompatible,
refuse and explain. No stored receipt or recovered binding flag authorizes
catalog loading or execution by itself. The new eligibility path and subsequent
normal acknowledgment preparation require fresh genuine runtime authority.

## Concurrency, idempotence and failure disposition

- A stale session/review, policy, runtime/client generation or binding preimage
  invalidates preparation. Refuse even if the thread ID is unchanged. Do not
  overwrite a concurrent winner or transfer another subscription.
- Use a server-owned operation record keyed by original session, review and
  operation ID with request fingerprint and prepared/committed/uncertain phases.
  Reusing an ID for different inputs conflicts. Repeating an identical committed
  request returns its known result without another native admission or binding
  write. None of these phases is acknowledgment.
- Before commit, release only reservations/subscriptions acquired by that exact
  operation. Conditional rollback must prove the same binding and physical
  owner generation; never restore an old snapshot over newer work.
- A lost native response or process crash with unknown admission/configuration
  outcome becomes `uncertain`. Inspect actual native/canonical state before any
  retry. Do not automatically replay configuration, acknowledgment or user input.
- If commit succeeded but the response was lost, read canonical disposition and
  return/reconcile that result. Do not blindly revert A to B. If current authority
  cannot be re-established, retain the pending review and report unavailable.

## Acceptance and evidence required before a fix claim

The regression fixture deliberately starts **after** the damage: review R names
A/T, the same existing conversation's binding names B, original catalog has 43
functions and UI preparation has 61. D1 observation and unused-B proof start
absent; fixture JSON must not fabricate them.

`test/fixtures/provider-review-recovery/plan.json` specifies 31 unexecuted cases.
R01/R02 must fail on prevention-only #179054 and pass on a real implementation.
Use the canonical store/host authorization and the real isolated Codex app-server
with generated test threads and a loopback-only test provider, not production
copies or real credentials. Enforce no outbound provider traffic or consequential
tools. Synthetic transport alone cannot establish D1.

Required proof includes owner/admin versus unauthorized/synthetic callers; wrong
session/review/thread/home; native and foreign owners; retained writer; changed
latest failure/findings; changed/unknown effective policy and catalog; executor
mapping; concurrent host/native changes; duplicate/partial/uncertain recovery;
CAS conflicts, cleanup and crash disposition; B with accepted input; and the
separate unchanged normal acknowledgment on A. Demonstrate review preservation,
zero turns or input replay during repair, and real accepted distinct native turn
only after explicit acknowledgment in the test environment.

Current evidence is narrower: 76 earlier offline checks of deployed refusal/
provenance behavior, plus 23 new supporting policy-comparison/fixture checks.
None proves successful recovery, a genuine live ownership observation, canonical
cross-store recovery commit/rollback, or full Gateway/native integration. The
new comparator never authorizes mutation; contract interfaces have no issuer.
Repository Vitest/build/typecheck/CI and the 31 integration cases remain unrun.

## Rollout and review boundary

This is a local proposal, not publication or deployment authorization. Before a
working implementation is offered: resolve D1, implement the broker/coordinator
and catalog preparation integration, satisfy the full acceptance suite, and
review security-sensitive ownership/transaction changes with maintainers.
Deployment/restart and a concrete canonical live reconciliation require explicit
owner approval. Normal acknowledgment remains a separate action. No key or other
credential changes are part of this proposal.

References: [prevention PR](https://github.com/openclaw/openclaw/pull/179054),
[unchanged native review validator](https://github.com/openclaw/openclaw/blob/e501abf29b6ac219df5196cc44fcfaf9f7bec12c/extensions/codex/src/app-server/provider-review-continuation.ts),
[supported operator handler](https://github.com/openclaw/openclaw/blob/e501abf29b6ac219df5196cc44fcfaf9f7bec12c/src/gateway/server-methods/sessions-provider-review.ts),
[existing catalog loader](https://github.com/openclaw/openclaw/blob/e501abf29b6ac219df5196cc44fcfaf9f7bec12c/extensions/codex/src/app-server/native-tool-catalog.ts).
