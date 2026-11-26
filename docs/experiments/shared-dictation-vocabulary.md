---
doc-schema-version: 1
summary: "M06 shared vocabulary decision, bounded first-flow proposal, prototype evidence, and qualification runbooks"
read_when:
  - "Reviewing shared dictation vocabulary authorization and storage proposals"
  - "Qualifying selected vocabulary, admitted work, recovery, or saved-data compatibility"
title: "Shared dictation vocabulary experiment"
---

# Shared dictation vocabulary experiment

This experiment records the decision needed for selected shared vocabulary, the
unregistered prototype, and the proof needed for one real Talk flow.
**Status: PLAN ONLY / NEEDS MAINTAINER. M06 remains incomplete.** The prototype
contains validation, resolution, mutable collection operations, snapshot leases,
and an optional relay guard. Production Talk does not select or transmit those
collections. This documentation revision changes no runtime behavior.

The selected issue is [openclaw/openclaw#205633](https://github.com/openclaw/openclaw/issues/205633).
It remains open. [Issue #191109](https://github.com/openclaw/openclaw/issues/191109)
is adjacent transcription-hint work; it is neither the implementation's parent nor
proof of shared authorization or provider acceptance. The coordinated personal
vocabulary proposal is now [P03 issue #205856](https://github.com/openclaw/openclaw/issues/205856).
Its common schema, personal store, and integration contract remain unaccepted.
M11 is a separate refinement proposal, not a required new service for this slice.

The [issue review](https://github.com/openclaw/openclaw/issues/205633#issuecomment-7178208349)
and [PR review](https://github.com/openclaw/openclaw/pull/205820#issuecomment-7185670785)
ask for a smaller owner/common-term contract, admitted-request semantics, real
behavior proof, and saved-data compatibility. The PR review completed November 26,
2026 at 2:37 AM ET against `56aef23a43aea74de1f20ed6e1cf81cc3c1756a5`, with zero
actionable code findings and two proof blockers. A refresh at 11:08 AM ET found
the same durable review and no human acceptance in the inspected discussions.
The review covers that historical head, not subsequent documentation commits.

| Review identity            | Recorded value                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation source base | `openclaw/openclaw:main`, `04b854b239cd8ab8a14beae4914ed9c54d791e62`                                                                                                                                                                |
| Published fork branch      | `CompleteDotTech/openclaw:feat/dictation-shared-dictionaries`                                                                                                                                                                       |
| Accepted common vocabulary parent | None. P03 is a proposal, and M11 is not a mandatory dependency of the recommended flow. |
| Historical qualification head | `70bac82c4c24bded28615002d52701940ee3494a`, followed by documentation head `56aef23a43aea74de1f20ed6e1cf81cc3c1756a5`. No product checks were rerun for this documentation revision. |
| Upstream review draft | [openclaw/openclaw#205820](https://github.com/openclaw/openclaw/pull/205820), open and unmerged at the refresh. Production readiness still needs design acceptance and proof. |

The recovered four-commit implementation was published through the authenticated
GitHub connection. Published head `927da4c148bd31c913a647366249b982a51bd9ff` has
the exact source tree `b3a8f9b8d13c3d5c8dbacf1d329a7110e8526b3d` of the previously
tested local head `058b21e885e3b3fedccbdeb66643abd525c163ff`. Each corresponding
commit tree was verified; only commit metadata and resulting commit IDs changed.
The initial fork draft targeted its real `main` branch, observed at
`f76b87badadd0c4d244d6529fb4da41894eb8b83`, with the source base above as its merge
base. The [fork-local review #1](https://github.com/CompleteDotTech/openclaw/pull/1)
was closed unmerged after the upstream design-review draft became the canonical
review. Neither publication establishes completed implementation or maintainer
acceptance. Repository guidance permits an upstream
draft to seek design review; production contract activation and readiness remain
gated on the recorded decision. Subsequent qualification evidence is recorded below.

The original issue has twelve acceptance criteria. The ledger below preserves each
one and identifies proposed amendments or deferrals. This narrower document cannot
resolve the original issue or silently replace its confidentiality and revocation
promises. Historical receipts mentioned below were external qualification artifacts,
not files supplied by this repository or evidence of a new run.

## Decision for the first flow

Should Talk support selected shared vocabulary, and what is the smallest common
personal/shared term, owner, storage, and admission contract needed for one real flow?

| Option | Behavior and cost | Acceptance would unlock |
| --- | --- | --- |
| Recommended: one common contract and one bounded flow | Agree the P03 term/resolver contract, one optional plugin/configuration owner, and one existing Talk client/provider path. Requires an accepted public integration seam and real qualification. | A small production implementation in the existing draft, followed by the runbooks below. Broader management stays deferred. |
| Existing configured provider hints | Exercise the provider-owned prompt configuration under its existing authority. It has no shared collection selection or common personal/shared lifecycle. | An explicitly limited provider experiment, without claiming M06 or P03 support. |
| Defer shared dictionaries | Preserve ordinary dictation and existing supported personal/configuration behavior while ownership or provider support is unresolved. | An explicit deferral with the original criteria still open. |

The recommendation is an optional feature decision. The current review does not
identify an existing-behavior defect that justifies inventing a repair.

### Proposed client, owner, and bounds

Every entry here needs acceptance. No table entry registers a permission, settings
key, SDK export, storage namespace, or supported provider capability.

| Boundary | Proposed first slice | Remaining decision or qualification |
| --- | --- | --- |
| Client | Linux desktop Chromium Control UI, `en-US` utterances, existing `mode: "transcription"`, `transport: "gateway-relay"`, `brain: "none"`. | Exact OS/browser/microphone and language mapping. `en-US` describes the spoken test scope, not a new Talk wire field. Native/mobile and other transports remain unqualified. |
| Common term and resolver | Start review with the internal `VocabularyTerm` fields `id`, `canonical`, `aliases`, `locales`, and `enabled`. Use one P03/shared normalization, protection, bounds, and conflict policy. | P03 owns the personal contract. This internal type is not an accepted public schema. Session choice, personal override, selected non-conflicting shared entries, then baseline is proposed precedence. Equal-priority conflicts stay visible and omitted. |
| Shared storage | An optional vocabulary plugin provisions an administrator-controlled static catalog through an accepted existing configuration mechanism. Talk consumes a bounded projection. Derived snapshots last only for their request. | Name the plugin/configuration owner and public SDK seam, content visibility, reload/deletion/backup policy, and unknown-version behavior. If the SDK cannot express this, record that gap before adding a contract. No shared database, sidecar, `users.prefs` catalog, transcript cache, or new audio retention is proposed. |
| Visibility and use | One trusted Gateway domain. Recommend `operator.read` for inspection, the actual existing Talk/session admission and disclosure policy for use, and admin configuration for provisioning. | Explicitly accept the change from confidential workspace membership. These existing scopes are not discovered dictionary permissions. Project grants and guessed IDs do not establish collection membership. Preserve the legitimate own-session route. |
| Provider | Qualify only the existing OpenAI realtime-transcription adapter first. | Verify the exact selected endpoint/model, encoded hint field, byte/token/term budgets, and actual recognition. No Gemini or alternate-provider support is claimed. |
| Capture and insertion | Keep the existing Talk, `ComposerDictationOwner`, `ComposerDictationSession`, `ComposerDictationCommits`, input, destination, and Undo owners. | One named integrator must coordinate schema, classifier, handler, client, adapter, and visible status. The proposed browser `dictationPreparation` policy is not vocabulary storage or an accepted hook. M11 refinement remains optional and separately gated. |

For the owner decision, propose four configured and four selected collections,
256 entries per collection, 65,536 UTF-8 bytes per complete serialized collection,
and 262,144 bytes for the complete catalog envelope. All limits apply together:
four maximum-size records plus the outer envelope can exceed the catalog limit.
P03 must separately bound personal and session inputs.

Propose 4,096 UTF-8 bytes for the complete encoded provider hint field/template,
subject to every lower verified adapter byte, token, and term limit. Count escaping
and envelope overhead. Explain deterministic omission. These values are unaccepted,
unmeasured proposal bounds, not provider quotas or a result for the old 5,000-term
target. Broad editing, import/export, audit history, tombstones, and offline leases
remain outside this first slice.

### Proposed admission, Stop, and recovery

Admit current selection, disclosure policy, and session authority once when work
starts. Normal catalog changes apply to the next request. New, queued, retried,
and replayed work needs fresh admission. Already admitted work may finish subject
to the actual transport and destination lifecycle. This explicitly amends AC04's
unconditional pre-egress/pre-commit feature reauthorization requirement.

Fresh authority does not mean silently changing pinned personal content. The
current [P03 proposal](https://github.com/openclaw/openclaw/issues/205856) pins the
personal revision at capture admission. A retry of that attempt should preserve it
while obtaining current authority and resolving shared selection as accepted.
If the old personal revision is unavailable or current policy forbids its use,
report refusal or a changed-version outcome and require an explicit restart.
This grants no new retention right. Recording again is a new capture, not proof
that an old attempt was retried.

Preserve the real requester/session/target, send/connect, socket-generation,
publication, input-revision, and destination guards. At the inspected M06 head,
WebSocket connection data resolves before the later current-authority check, and
the inbound handler checks socket ownership before capture/parse without a fresh
`ensureCurrent` call. [P02 draft #205876](https://github.com/openclaw/openclaw/pull/205876)
addresses credential-dispatch and inbound-frame authority, but remains unmerged.
Verify an accepted, landed equivalent of those transport checks before live
qualification. Admission once neither removes existing guards nor proves missing
P02 hardening already exists. P02 supplies no selected-context consent source.

Normal Stop may drain authorized final transcripts. Discard and retired ownership
prevent their corresponding late publication. Hinted speech-to-text (STT) output
keeps its hint lineage, even if later processing adds no hints. Cancellation cannot
recall previously disclosed terms or turn that output into a hint-free baseline.

The first recovery proposal is manual correction of eligible text or an explicit
new recording. The browser has no replayable retained-audio artifact, and the file
path removes its temporary audio. The prototype `vocabularyRecovery` descriptor
does not retain or replay audio. Re-transcribing old audio requires a separately
accepted retention/recovery owner and current admission.

## Existing owners and missing contracts

| Responsibility                            | Existing owner                                                                                                         | M06 boundary and remaining decision                                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated people                      | `src/state/user-profiles.ts`, `user-profiles-owner.ts`, and `user-profile-list.ts`                                     | Reuse canonical identities. A profile or connected Gateway alone does not authorize a dictionary.                                                                                                                                                                   |
| Operator roles and project access | `src/gateway/operator-role-policy.ts` and `src/gateway/project-access.ts` | Accept the proposed trusted-Gateway read/use/admin mapping before enabling it. Wider edit/export and confidential membership remain separate decisions. |
| OpenClaw ID authority | `src/gateway/openclaw-id/authority.ts`, `claw-store.ts`, and `tunnel-principal.ts` | Preserve actual principal and transport authority. Do not manufacture a vocabulary membership database or a second revocation service. |
| Plugin request authority                  | `src/plugin-sdk/gateway-request-authority.ts` and `src/plugins/runtime/gateway-request-scope.types.ts`                 | The inspected `GatewayRequestAuthorityV1` exposes current request authority and person attribution, but no accepted dictionary/workspace membership capability. A plugin must not infer it from a scope string or import private Gateway policy to manufacture one. |
| Durable plugin state | `src/plugin-state/plugin-state-store.ts`, its types, and `src/plugin-sdk/plugin-state-store-runtime.ts` | The historical mutable prototype injects this V2 store. The recommended static catalog does not activate it. Any later mutable namespace, retention, quota, or representation needs its own accepted contract. |
| Speech session and transcript publication | `src/gateway/talk/handlers/session.ts` and `src/gateway/talk/transcription-relay.ts`                                   | Keep transcription in the existing `mode: "transcription"`, `brain: "none"` owner. The optional lease guard does not create a recognizer or insertion owner.                                                                                                        |
| Browser dictation                         | `ui/src/pages/chat/composer-dictation-session.ts`, `composer-dictation.ts`, and `composer-direct-dictation.ts`         | Existing clients remain their own capture/draft owners. This prototype adds no collection picker, accessible management, source inspector, or recovery controls.                                                                                                    |
| Provider capabilities                     | `src/realtime-transcription/provider-types.ts`, `provider-contexts.ts`, and `src/plugins/capability-provider.types.ts` | An accepted adapter must supply verified hint fields and exact budgets. No production provider advertises this prototype's vocabulary capability.                                                                                                                   |
| Personal vocabulary and refinement | P03 common vocabulary proposal and existing Talk/composer owners | P03 remains unaccepted. A separate M11 framework is not required for the first flow, and this proposal does not enable remote refinement. |

[Operator scopes](/gateway/operator-scopes) describe collaboration within a trusted
Gateway domain. Project/source access also covers broader use cases than private
dictionary membership. Reusing either surface without an explicit mapping would
silently change its confidentiality meaning. The proposed trusted-Gateway scope
requires an explicit maintainer amendment to AC01, alongside the AC04 amendment.
The current prototype's grant checks are described below as historical behavior,
not the accepted mapping or lifecycle of the narrower proposal.

The closed `TalkSessionCreateParamsSchema` has no collection-selection field.
Own-session classification accepts only `sessionKey`, `mode`, `transport`, and
`brain`. The production session handler never constructs a vocabulary envelope,
and the relay passes `providerConfig` unchanged. These are linked source gaps:
schema, scope classification, handler, client, and provider serialization must move
together after acceptance. A configured provider prompt alone does not fill them.

The [storage review checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes)
requires recorded design acceptance for public contracts, schemas, retention,
durability, and permission changes. A new JSON representation in an existing table
does not avoid that checkpoint. An upstream draft may present the proposal for
design discussion without claiming acceptance or enabling these contracts. Issue #205633 records the proposed feature; filing
it does not constitute acceptance. The present code is unregistered and introduces
no SQL schema, personal-store migration, plugin SDK export, or public RPC.

## Implemented internal boundaries

This section describes the unchanged, unregistered historical prototype at
`56aef23a43aea74de1f20ed6e1cf81cc3c1756a5`. Its mutable store, repeated grant checks,
and lease invalidation are broader than the proposed first flow. No source cutover
to the new storage or admission recommendation has occurred. An accepted cutover
must retire superseded policy and callers together, with focused production proof.

`src/realtime-transcription/vocabulary-types.ts` defines proposed immutable term,
collection, source, conflict, capability, and live-grant types.
`vocabulary-terms.ts` validates imports, resolves precedence, and selects a bounded
canonical hint list. `vocabulary-collections.ts` provides scoped management over an
injected V2 store. `vocabulary-snapshot.ts` pins one utterance's contents and retains
host-owned authority handles. These modules perform no speech recognition or
transcript substitution.

### Terms and limits

Schema version 1 terms contain `id`, `canonical`, `aliases`, `locales`, and
`enabled`. Canonical spelling retains its supplied Unicode, case, accents, and
punctuation. NFC is used for comparison; there is no case folding or compatibility
folding that could merge distinct identifiers. Locales are canonicalized through
`Intl.getCanonicalLocales`; an unknown utterance locale admits only locale-neutral
entries. Duplicate term IDs, equivalent canonical spellings, duplicate aliases,
unknown fields, accessors, invalid locales, control characters, and lone surrogates
are rejected. Validation copies and freezes accepted records and arrays before
asynchronous authorization can yield.

| Boundary                                              | Prototype limit                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Collection terms                                      | 5,000                                                                       |
| Normalized collection draft and raw JSON import       | 400 KiB each, measured as UTF-8 bytes                                       |
| Personal input                                        | 1,000 terms                                                                 |
| Selected shared collections                           | 8                                                                           |
| Combined session, personal, and selected shared input | 5,000 terms and 400 KiB of normalized term data, including disabled entries |
| Canonical spelling or alias                           | 1,024 UTF-8 bytes                                                           |
| Aliases and locales per term                          | 16 each                                                                     |
| Collection label                                      | 256 UTF-8 bytes                                                             |
| Import nesting                                        | At most 6 levels, checked before `JSON.parse`                               |
| Collection listing                                    | At most 32 stored rows per lexical range page                               |
| Audit ring                                            | At most 32 events per collection                                            |

These are implementation guardrails proposed for review, not production-capacity or
provider guarantees. The synthetic local measurements below qualify only their named workloads. The existing store's value and namespace quotas remain in
force. Production quota exhaustion must reject an operation safely; it must not
evict tombstones to admit a new collection.

The resolver orders explicit session choices, personal overrides, then selected
shared terms. Baseline recognition remains the owner's normal behavior. Equal
priority shared alias conflicts are returned as data, with the affected canonical
hints omitted. Arrival order cannot select a spelling. Sources retain the personal
revision or shared scope, collection, and revision. The resolver does not read or
write a personal dictionary. Private personal inputs in fixtures do not establish
a working production personal-vocabulary lifecycle or visible conflict UI.

### Collection storage, concurrency, and audit proposal

These are the historical mutable prototype's operations and proposed durability
obligations. They are deferred from the recommended administrator-provisioned
static catalog, which has no collaborative writes, exports, audit ring, or tombstones.

The collection service requires an opener bound to a live `VocabularyGrant` and
the existing `PluginStateKeyedStore<VocabularyCollection, 2>` operations `observe`,
`compareAndApply`, and `entriesInKeyRange`. The accepted host adapter must pass
current authority into final worker admission, using the
[existing worker storage owner](/reference/database-schemas/worker-access). The
isolated real-worker fixture now qualifies this proposed adapter's CAS, final write
admission, orderly reopen, and record-size behavior with synthetic grants. It does
not establish the production permission or namespace mapping.

Collection keys are `${scopeId}:${collectionId}`. Both identifiers are ASCII
letters, digits, `_`, or `-`, with length 1–128; neither can contain `:`. Creation
allocates the collection ID on the service side. The active row contains scope,
ID, schema version, monotonic revision, update time, label, terms, and audit. A
caller cannot supply a replacement ID through an import.

Every operation requests the host permission before observing a row or listing a
scope. Create/delete require management permission; replace/import require edit;
export requires export permission. Operations returning collection contents or
revision information also require read. Audit requires management and read;
listing requires scope-wide read. The service revalidates grants around awaited
work and checks current authority before returning a result. Denied, missing,
deleted, and mismatched-scope reads return the same unavailable category without
echoing identifiers or private metadata. Revision conflicts are exposed only after
an authorized read/edit admission.

Replace, import, and delete require the expected revision. The service combines
that revision check with the observed store comparison token in one CAS. Import
validates the entire bounded draft before writing. The collection and its audit
event are written together. A concurrent winner changes the token; the loser
receives a conflict, with no lost update and no automatic retry. A failed CAS
transport reports an unknown outcome because a write may have occurred. A
successful commit followed by loss of reply authority reports committed without
releasing private content. Neither receipt authorizes replay.

Deletion writes a tombstone containing scope, ID, schema version, advanced
revision, update time, and minimized audit. It drops label and terms. Replace and
import cannot reactivate it. List validates every returned row, including deleted
rows used for pagination, before returning a cursor. Unknown versions remain
untouched and unavailable to interpretation, including unknown-version tombstones.

The real-worker maximum-size case uses 5,000 terms, an exact 409,600-byte
normalized draft, maximum-length actor/scope/collection identifiers, and a full
32-event audit ring. After an orderly worker close, the entire term array and
label survive. The stored record exceeds the draft limit but remains within the
existing 1,048,576-byte per-value ceiling. This constructed case proves record
compatibility; it does not measure namespace exhaustion, every serialization
shape, crash recovery, or power-loss durability.

The proposed dedicated namespace must retain tombstones without TTL or eviction
until an accepted synchronization/garbage-collection policy can prove that stale
clients cannot recreate them. The 32-event audit ring retains only actor ID,
operation, revision, time, and term count. It is a bounded recent-change record,
not a complete access or compliance log. Access-policy events remain with the
authorization owner; their audit integration is unresolved. Normal collection
views, snapshot inputs, and exports omit administrative actor history. Detailed
term diffs, raw transcripts, and personal overrides are never added to this ring.
The audit window, actor visibility, retention duration, deletion policy, and quota
impact still need design acceptance.

Export emits only the requested draft's schema version, label, and terms. It
excludes scope/collection IDs, audit actors, unrelated collections, and personal
records. Import/export is an explicit content transfer, not an authorization token
or an automatic migration. No production personal store is opened by this code.

### Snapshot authority and provider disclosure

The following lease behavior remains in the prototype. Its repeated feature
authorization and immediate invalidation differ from the proposed admission rule.
The documentation amendment does not change that code or claim it is ready to enable.

A snapshot copies its selected collections and personal/session inputs, pins
source revisions, and bounds resolution before exposing an immutable view. A
separate host `disclose` grant binds shared content to the selected provider.
Captured read grants and disclosure grants must identify the same actor. Missing,
expired, revoked, or unverifiable authority makes shared work unavailable.

Ordinary content edits affect later utterances. Security revocation invalidates
the active lease, removes its retained effective data and grant references, and
notifies consumers. The host must publish those invalidations; the prototype does
not discover membership itself. Each STT/refinement egress revalidates current
grants. One lease admits each stage once; retry requires a new currently authorized
snapshot. There is no offline membership cache or implicit offline lease.

The capability boundary supports either `unsupported` or an explicitly supplied
canonical-list encoder with term, byte, and token budgets. The trusted adapter
must measure its actual encoded payload and tokenizer. Deterministic prefix
selection reports omitted counts and supported/truncated/unsupported status.
Synthetic measurements validate budgeting behavior only. No OpenAI, Gemini,
local-provider, or other live endpoint is qualified by this experiment. An
existing prompt field in `extensions/openai/realtime-transcription-provider-factory.ts`
does not prove acceptance, effective hinting, or safe use of the new term contract.
At this source head, the adapter uses
`wss://api.openai.com/v1/realtime?intent=transcription`, defaults to
`gpt-4o-transcribe`, and serializes configured context into
`session.audio.input.transcription.prompt`. These are source facts, not current
remote-service guarantees. The fake-WebSocket provider test checks serialization
only. Recheck the selected model, lifecycle, endpoint documentation, and actual
token/byte/term budgets during live qualification. No historical quota quotation
qualifies the proposed payload or establishes recognition benefit.
No provider route is selected from term text and no alternative route is attempted.
The lease currently binds one provider/capability to both nominal stages. It does
not qualify differing STT and refinement endpoints or their distinct budgets.
Remote refinement remains a separate decision outside the first flow.

### Hinted STT lineage and recovery

Prepared egress carries snapshot ID, stage, provider, and whether the result is
shared-derived. Refinement inherits prior shared STT lineage even when it adds no
new shared hint. The optional Talk relay guard rejects stale, wrong-provider, or
wrong-stage admissions; checks current authority for audio and callbacks; requests
session closure after invalidation; and checks publication before transcript
events. Provider error messages are redacted for vocabulary-bound sessions.

This connects the prototype to an existing publication owner, but no production
session handler constructs the lease or sends its hints through a qualified
adapter. The prototype's invalidation callbacks depend on a host integration that
does not exist. The recommended flow instead uses accepted P03 vocabulary and
the existing Talk/composer lifecycle. No new M11 coordinator is required.

A newly arriving result from hinted STT cannot become a supposedly independent raw
fallback after revocation. Already accepted user-owned material remains under its
existing policy; cancellation cannot undo an earlier publication or recall a
request already sent to a provider. `vocabularyRecovery` describes manual recovery
when permitted audio is absent, or an explicit new transcription when the caller
already has policy-permitted retained audio. It records no audio, starts no retry,
and performs no insertion. Actual recovery controls and the retained-audio policy
integration are blocked; the descriptor is not a working retranscription flow.

## Acceptance and evidence ledger

The criterion names below map individually to the original
[issue acceptance criteria](https://github.com/openclaw/openclaw/issues/205633).
The first-slice column records proposed changes only. Original AC01's confidential
scope and AC04's unconditional reauthorization are not satisfied by those proposals.
Maintainers must accept any amendment, and deferred criteria remain unresolved.

**PARTIAL** means source and focused regression cases cover a prerequisite while
the complete production criterion remains unmet. **BLOCKED** means the required
product path or qualification is absent. There is no complete criterion in this
prototype. The test references below identify evidence sources; they do not by
themselves claim a successful run.

| Evidence ID | Exact source/procedure                                                  | Evidence boundary                                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1          | `src/realtime-transcription/vocabulary-collections.test.ts`             | Synthetic two-scope authority and Map CAS fixture; includes guessed IDs, export/audit separation, simultaneous editors, malformed import, tombstones, unknown versions, and committed/unknown receipts. No real host ACL or worker persistence proof.                                                                       |
| E2          | `src/realtime-transcription/vocabulary-terms.test.ts`                   | Deterministic import, Unicode/locale, precedence/conflict, immutable-input, hostile-data, aggregate-bound, and exact synthetic encoder tests. No spoken corpus or live endpoint proof.                                                                                                                                      |
| E3          | `src/realtime-transcription/vocabulary-snapshot.test.ts`                | Synthetic grant invalidation, captured-input, expiry, per-egress revalidation, pinned edit, replay rejection, lineage, and recovery-descriptor cases. No actual membership service or M11 coordinator.                                                                                                                      |
| E4          | `src/gateway/talk/transcription-relay.vocabulary.test.ts`               | Real relay, Talk event controller, cleanup, and vocabulary lease with fake provider/authority; unrelated persistence/diagnostics are mocked. Exercises late hinted results, no replay, accepted-event preservation, admission, and redaction. No actual transmitted vocabulary or recognition proof.                        |
| E5          | Existing `src/gateway/talk/transcription-relay.test.ts`                 | Observed standard aggregate Gateway run: 18 existing relay regressions passed alongside the 12 vocabulary cases. Provider sessions remain synthetic.                                                                                                                                                                        |
| E6          | `scripts/bench-vocabulary.mts`                                          | Three 5,000-term workloads, each with 20 warmups and 100 samples per operation. Reports exact byte sizes, latency, sampled memory occupancy and GC. Authentication, network/model time, provider quotas and cumulative allocations are NOT MEASURED.                                                                        |
| E7          | Production qualification                                                | Accepted host/store mapping, real two-editor operations, saved-state migration, endpoint payload/quota checks, spoken corpus, actual keyboard/screen-reader controls, and supported-client recovery. NOT RUN; required dependencies absent.                                                                                 |
| E8          | `src/realtime-transcription/vocabulary-collections.integration.test.ts` | Actual V2 retained worker store with synthetic grants: concurrent CAS, atomic malformed import, tombstones after orderly worker close/reopen, final commit-admission revocation, and an exact 400-KiB/5,000-term draft plus full audit ring. No production ACL, migration, namespace-exhaustion, or crash-durability claim. |

| Criterion                        | Status  | Original target and historical prototype coverage                                                                                                                                        | Original missing proof                                                                                                                                                                                             | Historical evidence                                | Proposed first-slice disposition |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --- |
| AC01 — Authorized scope          | PARTIAL | Host authorization plus collection/snapshot owners; E1/E3 fail closed and bind requested scopes to grants.                                                                   | Accepted real membership/ACL mapping, store opener, RPC, guessed-ID matrix against those production boundaries.                                                                                           | E1/E3; observed focused run; receipt head             | AMEND: trusted-Gateway read/use/admin proposal needs explicit acceptance. Confidential workspace membership and broader writes/export remain unresolved. |
| AC02 — Resolution                | PARTIAL | Proposed P03 resolver; E2 checks session/personal/shared precedence and unresolved conflicts.                                                                                | Accepted P03 integration, real private personal lifecycle, visible selection/source/conflict UI.                                                                                                          | E2; observed focused run; receipt head                | RETAIN: one accepted P03/shared resolver, private personal data, precedence, and visible conflicts need real integration. |
| AC03 — Provider contract         | PARTIAL | Provider adapter owner; E2/E3 bound synthetic canonical-list hints and expose unsupported/truncated status.                                                                  | Verified endpoint fields, tokenizer/payload limits, actual authorized transport, visible capability disclosure, refusal without rerouting.                                                                | E2/E3/E7; live proof NOT RUN                          | RETAIN: qualify one named adapter/endpoint. Visible budgets and unsupported status need actual client/provider proof. |
| AC04 — Revocation                | PARTIAL | Host authority, snapshot owner, existing Talk relay, future M11/M10; E3/E4 cover hinted lineage and late-result rejection.                                                   | Production membership invalidation, actual hint dispatch/refinement/insertion races, explicit authorized retranscription and no-audio UI recovery.                                                        | E3/E4/E5/E7; observed focused run; receipt head       | AMEND: fresh admission for new work, admitted work may finish under real transport/Stop/owner guards. Keep lineage, no recall, and explicit recovery. |
| AC05 — Concurrent edits          | PARTIAL | V2 store owner and collection service; E1/E8 cover CAS, complete-import rejection, tombstones, uncertain receipts, and actual worker reopening.                              | Accepted production namespace/authority mapping and real management conflict recovery.                                                                                                                    | E1/E8 observed; production client proof NOT RUN       | DEFER: the static first catalog has no collaborative editing, imports, or deletion synchronization. Historical CAS fixtures do not complete this criterion. |
| AC06 — Migration                 | PARTIAL | Existing store/migration owner; prototype preserves unknown versions and limits export to one authorized draft.                                                              | Accepted migration/rollback/retention contract and actual saved-state upgrade/downgrade proof; no P03 migration exists here.                                                                              | E1/E7; migration NOT RUN                              | RETAIN personal nonpublication and real stable-to-candidate preservation. Broader collection migrations/export and downgrade semantics need separate acceptance. |
| AC07 — Offline lifecycle         | PARTIAL | Host authority and utterance owner; E1/E3 reject expired/disconnected grants and require fresh work after reconnect.                                                         | Real connectivity changes, visible unavailable state, accepted personal-only path, retry/reconnect integration.                                                                                           | E1/E3/E7; client proof NOT RUN                        | CLARIFY: unavailable fresh authority blocks new shared work visibly. Admit retries afresh while preserving P03's proposed personal pin once accepted. A reconnect alone does not change identity. |
| AC08 — Isolation                 | PARTIAL | Validator, capability adapter, route owner; E2 rejects malformed imports and keeps hostile text in a data list.                                                              | Qualified adapter encoding, real no-tool/no-mode/no-route behavior, cross-scope transport inspection.                                                                                                     | E2/E4/E7; live proof NOT RUN                          | RETAIN inert data and no tool/mode/provider changes. The trusted-Gateway proposal does not establish hostile-tenant confidentiality. |
| AC09 — Accessibility and clients | BLOCKED | Existing browser/native client owners.                                                                                                                                       | Collection selection/management, source inspection, conflicts, recovery, keyboard and supported screen-reader trials.                                                                                     | E7; NOT RUN; no UI added                              | RETAIN for the first browser flow. Broader advertised consumption and management remain deferred until their own evidence exists. |
| AC10 — Privacy                   | PARTIAL | Collection, snapshot, relay, store and diagnostic owners; E1/E3/E4/E8 separate audit/export, retain minimized worker records, and redact vocabulary-bound provider failures. | Accepted audit visibility/retention, real telemetry/cache/admin/export review, production resource lifecycle proof.                                                                                       | E1/E3/E4/E8; observed runs; receipt head              | RETAIN: accept static configuration visibility, deletion, backups, and request-only snapshot lifetime. No new transcript or audio retention. |
| AC11 — Performance               | PARTIAL | Validator/resolver, store and adapter owners; bounds are encoded; E8 verifies an exact maximum draft with full audit fits the actual store value quota.                      | A repeatable below-50-ms target (the refreshed compact case misses it), cumulative allocation instrumentation, production resource proof, and actual provider quotas. Synthetic timing results are below. | E2/E6/E8; observed benchmark/store runs; receipt head | CHANGE BOUNDS: measure the accepted smaller catalog and provider limits. Original maximum-scale and cumulative-allocation proof remain unmet. |
| AC12 — Semantic regression       | PARTIAL | P03, provider, and future M11 validation owners; E2 preserves exact spelling and performs no transcript substitution.                                                        | Spoken common-word/identifier/negation/number/literal corpus, real hinted recognition, and unaffected personal-only dictation.                                                                            | E2/E7; spoken/client proof NOT RUN                    | RETAIN: real paired spoken trials and ordinary/personal baseline. Helper normalization or one spelling success cannot establish this criterion. |

### Observed local verification

The following historical qualification ran on November 26, 2026 at implementation
head `70bac82c4c24bded28615002d52701940ee3494a` and was recorded by documentation
head `56aef23a43aea74de1f20ed6e1cf81cc3c1756a5`. It used a physical complete workspace
installation, reconciled with the frozen lockfile and pinned pnpm 12.15.0.
The dependency supply-chain check passed for 1,764 packages. Tests used the
repository's `run-vitest.mjs` wrapper, installed patched Vitest, Node 24.22.3,
standard project configurations, one worker, and the supported throttled mode.
Commands, logs, and source hashes were recorded with the external validation
receipt. That receipt is not a repository artifact. These observations are retained
without claiming a fresh installation, rerun, or new-head CI result.

| Check                                                                             | Observed result                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1–E3 standard vocabulary behavior                                                | 39 tests passed in three files under `vitest.unit-src.config.ts`. That initial combined command also included E8 in the wrong thread owner and exited unsuccessfully; E8 was subsequently corrected and rerun below.                                                                                                                                                                                                                                   |
| E8 actual retained worker store                                                   | PASS: 4 tests under standard `vitest.infra.config.ts`, using the existing isolated process owner and production runtime worker preset. Covers concurrent CAS, atomic import rejection, persisted tombstones, final admission refusal, and a maximum-size draft/audit row.                                                                                                                                                                              |
| E4/E5 vocabulary and existing Talk relay                                          | PASS: 30 tests in two files under the existing aggregate `vitest.gateway.config.ts` with `OPENCLAW_GATEWAY_PROJECT_SHARDS=0`. The 18 existing cases and 12 vocabulary cases use production runtime worker preparation.                                                                                                                                                                                                                                 |
| Runtime selection and project routing                                             | PARTIAL: all 51 existing runtime-selection tests passed. The broader project-config suite passed two tests, then its full-shard config subprocess stalled; the unchanged 120-second no-output watchdog terminated the run (exit 143). The existing full-suite file-ownership audit passed separately (one selected case, 40 filtered out), proving each discovered normal test has exactly one owner. No broader project-config-suite pass is claimed. |
| Tooling test type leaf                                                            | PASS: canonical `tsconfig.test.root.tooling.json` leaf through `run-tsgo.mjs` using the supported throttled Go fallback. This covers the changed planner and included test callers; it does not establish full core or collection/relay test-graph types.                                                                                                                                                                                              |
| Core production types                                                             | BLOCKED: canonical `pnpm tsgo:core` terminated with exit 137 using the supported throttled Go fallback; no source diagnostic established a product type error.                                                                                                                                                                                                                                                                                         |
| Type-aware core lint                                                              | BLOCKED: targeted `run-oxlint.mjs` with the core tsconfig terminated when `tsgolint` received SIGKILL.                                                                                                                                                                                                                                                                                                                                                 |
| Type-aware scripts lint                                                           | PASS for the benchmark and runtime selector after repairing three `no-misused-promises` diagnostics. The benchmark now calls explicit synchronous major GC through a void callback; no cast or lint suppression was used.                                                                                                                                                                                                                              |
| Syntax lint / formatting                                                          | PASS: syntax-only lint for all 14 changed TS/MTS/MJS paths and repository formatting for all 15 supported changed source/doc paths. Syntax-only lint does not replace type-aware proof.                                                                                                                                                                                                                                                                |
| Documentation                                                                     | Changed-document MDX sanity passed. The global anchor/link audit found eight failures in unchanged unrelated source/target documents; this document was not reported. Baseline execution was not repeated. ClawHub fragments remain unverified without the external mirror. The global docs audit is not a pass.                                                                                                                                       |
| Test-line allocation                                                              | PASS: 1,435 net test lines, 400 standard allowance, 1,035 explicitly allocated.                                                                                                                                                                                                                                                                                                                                                                        |
| Full build                                                                        | BLOCKED: default preflight could not see the process memory limit and stopped before cleaning output. A supported explicit 1,536-MiB heap attempt completed native protocol, script checks, plugin assets, AI and package phases, then failed in main `tsdown` when a child received SIGKILL; overall exit 1. No full-build success is claimed.                                                                                                        |
| Required unused-file scan                                                         | FAIL / BLOCKED: the production Knip scan reports `src/realtime-transcription/vocabulary-collections.ts` as unused because it has no production registration. The full-tree scan exhausted the explicit 1,536-MiB JavaScript heap and aborted (SIGABRT). No entrypoint or ignore was fabricated to hide the unregistered proposal.                                                                                                                      |
| Other full test/script type graphs                                                | NOT RUN to completion; the full core graph remains capacity-blocked. The earlier narrow pure-boundary check is not a substitute.                                                                                                                                                                                                                                                                                                                       |
| Required CI                                                                       | NOT RUN to completion. At qualification head `70bac82c4c24bded28615002d52701940ee3494a`, [CI](https://github.com/openclaw/openclaw/actions/runs/45773743254) reports `action_required` with zero jobs; [Proof](https://github.com/openclaw/openclaw/runs/139752289972) is skipped. PR context/evidence passed, which is not build/test proof. This row is historical evidence for that qualification head only.                                                       |
| Production authorization, migration, UI/accessibility, provider and spoken corpus | NOT RUN; accepted production integration is absent. E8 qualifies actual worker storage under synthetic grants only.                                                                                                                                                                                                                                                                                                                                    |

The first E8 attempt failed during setup because the thread owner had no host
shared-state broker. Adding this actual SQLite consumer to the existing database
worker registry selected the appropriate forked-process infra owner. Full compiled
test-worker preparation then terminated with exit 137 before tests. Source review
qualified exactly E8 and the two relay suites for the existing runtime-only preset:
their fixture code executes in Vitest, and their worker children use production
entries. The runtime graph retains production declarations; broad or mixed
selections still use the full graph. Compiler verification, worker admission, IPC
ownership, and lifetime cleanup were not skipped or weakened. The failed setup
logs remain alongside the successful runs. No failed product assertion was made
green by weakening a test.

The earlier 51-test supplemental run and strict standalone pure-boundary type
check remain historical evidence from the identical original implementation tree.
They used a narrow config/source aliases and unpatched Vitest after the earlier
installation failed, so they are separate from the refreshed standard-lane proof.
The historical benchmark workloads and production functions are unchanged. The
refreshed runner makes its synchronous major-GC callback explicit after a
type-aware script lint finding; a fresh run is recorded separately below. The required build, canonical types,
type-aware lint, unused-file gate, and applicable CI must pass before readiness;
passing boundary tests does not complete M06.

### Maximum-bound performance

#### Refreshed run — November 26, 2026

After repairing the benchmark callback's type-aware lint failure, the complete
benchmark ran again on Linux x64, Intel Xeon Platinum 8573C, Node 24.22.3, with
nine logical CPUs. Each operation/workload still uses 20 warmups and 100 measured
samples, nearest-rank percentiles, and 5,000 eligible terms. Explicit synchronous
major GC occurs outside the timed operations. No other task-owned compiler, test,
linter or build ran concurrently; the script does not establish an otherwise idle
host. Its one-minute load averages were 0.37 before and 0.73 afterward.

| Workload                                          | Raw / normalized draft bytes | Parse + validate p95 | Resolve p95 | Combined p95 | Combined below 50 ms |
| ------------------------------------------------- | ---------------------------- | -------------------- | ----------- | ------------ | -------------------- |
| Compact terms                                     | 382,395 / 382,395            | 80.85 ms             | 11.89 ms    | 50.20 ms     | MISS                 |
| Exact raw limit, whitespace padding               | 409,600 / 382,395            | 39.54 ms             | 14.18 ms    | 43.72 ms     | PASS                 |
| Exact normalized draft limit, actual term padding | 409,600 / 409,600            | 33.08 ms             | 15.64 ms    | 41.22 ms     | PASS                 |

The compact workload missed the strict target at 50.200470 ms; the refreshed run
does **not** establish a uniform below-50-ms p95. The original passing run below
remains historical evidence, not a substitute for this result. Production
validation/resolution functions and workload contents did not change. This
observation does not isolate the cause of timing variation or prove a regression
from the explicit GC callback. No repeated run was selected merely to obtain a
passing number.

Sampled heap increases across these operation batches ranged from 110.0 to
170.7 MiB. As before, these are sampled process-occupancy values, not cumulative
allocation or instantaneous peak proof. Authentication, network/model execution,
and actual provider quotas remain NOT MEASURED. Raw samples, CPU/memory counters,
methodology, and source hashes are retained with the refreshed receipt.

#### Historical run — November 25, 2026

Measured November 25, 2026, on Linux x64, Intel Xeon Platinum 8573C, Node 24.22.3
(V8 13.6.233.17-node.63), with nine logical CPUs reported. Each row contains 5,000
unique enabled terms. Each operation ran 20 warmups followed by 100 measured
samples. Percentiles use nearest rank. Authentication, network and model work
were excluded and not separately executed.

| Workload                                          | Raw / normalized draft bytes | Parse + validate p95 | Resolve p95 | Combined p95 |
| ------------------------------------------------- | ---------------------------- | -------------------- | ----------- | ------------ |
| Compact terms                                     | 382,395 / 382,395            | 24.78 ms             | 9.84 ms     | 31.20 ms     |
| Exact raw limit, 27,205 trailing whitespace bytes | 409,600 / 382,395            | 19.50 ms             | 7.00 ms     | 27.24 ms     |
| Exact normalized draft limit, actual term padding | 409,600 / 409,600            | 25.09 ms             | 7.08 ms     | 38.54 ms     |

All three observed combined p95 values were below the proposed 50 ms target in
this run. The normalized term array in the last row is 409,542 bytes; 58 bytes
belong to draft metadata. The effective projection is larger because it includes
source lineage. These measurements do not promise every host or provider meets
the same latency or accepts the same collection size.

The first run missed the combined target: p95 was 57.10, 265.85 and 61.58 ms for
the same three workloads. The retained before/after JSON reports distinguish this
from a fresh measurement selected without a code change. The repair removed
per-code-point JSON scanning and unnecessary conflict/alias allocations for
singleton admitted terms; the full focused suite and independent source review
were repeated. Host load also differed, so the reports do not establish a causal
speedup ratio.

Across final 100-sample batches, sampled peak heap increases ranged from about
67.7 to 172.4 MiB. After result release and explicit GC, heap usage was below each
post-warmup starting measurement. These are process occupancy observations,
not per-call peak memory, cumulative allocated bytes, or a leak-proof claim.
Automatic GC is included when it happens inside timed calls; explicit GC occurs
only between batches. Raw samples and all memory counters are retained.

Reproduce the benchmark only in the policy-approved execution environment after
installing the normal repository dependencies:

```bash
node --expose-gc --import ./scripts/tsx.mjs scripts/bench-vocabulary.mts
```

### Independent review and simplification

Separate agents reviewed authorization placement, scoped store operations,
source lineage, revocation, error privacy, bounded parsing, quotas and personal
data separation. This is independent automated source review, not maintainer
acceptance or executed production proof. Three actionable defects were repaired:
mutable collection/grant selection across awaited authorization; private provider
errors on relay stop/finish paths; and sparse alias-array validation. A wrong-stage
relay guard and required closed-mock annotations were also added. The reviewer
reported no remaining actionable defect in the re-reviewed scope. A subsequent
independent review of the real-worker tests repaired a weak concurrent-winner
assertion: reopened state now equals the fulfilled editor's returned collection.
The final test and exact runtime/infra routing additions were re-reviewed with no
remaining actionable code finding; synthetic authority and orderly restart limits
remain explicit.

The implementation keeps one validation/resolution owner and one existing Talk
publication owner. Collection operations use the existing V2 store contract;
no alternate database, recognizer, transcript store, identity system, or recovery
coordinator was added. Error normalization is shared across provider failure
paths. The code remains separable into term/budget, collection, and snapshot/relay
prerequisites for review; none is an accepted enabled product contract.

## Migration, rollback, and qualification sequence

No production namespace is opened and no personal dictionary is migrated by this
prototype. An upgrade must never discover personal terms and publish them as
shared data. The proposed first activation is explicit selection through the
accepted static configuration and Talk owners. Unknown versions stay intact and
visibly unavailable under their accepted reader policy.

The following procedures are **NOT RUN**. They address the review's real-behavior
and compatibility blockers after the owner decision and production entry point
exist. A runbook, release lookup, synthetic grant, helper result, or screenshot from
another PR is not execution evidence.

### Record the implementation decision

Before implementation, record acceptance of the common P03 term/resolver and
personal store, trusted-Gateway visibility, read/use/admin mapping, AC04 amendment,
static catalog bounds and configuration owner, retention/deletion/backup policy,
and the named Talk/client/provider integrator. Record which original criteria
remain deferred. Keep absent/disabled behavior and remote refinement off.

Confirm the actual public SDK seam and any required transport prerequisite.
The closed request schema, own-session classifier, handler, client, and adapter
need a coordinated change. Do not register the broader mutable store or add a
second authorization/lease service to make the runbook appear executable.

### Qualify one real product journey

Use a policy-approved execution environment, an isolated task-owned Gateway
state/config directory, a free port, and a new browser profile. A copied checkout
alone is not isolation for untrusted fork scripts. Provider access requires
reviewed-source authority and separately authorized task access. Missing hardware,
provider access, or assistive technology leaves the affected proof NOT COLLECTED.

Build the exact accepted candidate with its pinned toolchain and documented
`pnpm build` and `pnpm ui:build` commands. Record commit/tree and build identity.
Verify that the Gateway serves the resulting `dist/control-ui` assets and that
the browser-fetched hashes match. Configure local mode and authentication through
the existing owner. With task-specific paths and the verified free port set, the
foreground command is:

```bash
OPENCLAW_STATE_DIR="$M06_STATE_DIR" OPENCLAW_CONFIG_PATH="$M06_CONFIG_PATH" \
  pnpm openclaw gateway run --bind loopback --port "$M06_GATEWAY_PORT"
```

Use a physical microphone, fictional terms, and the named screen reader. Capture
only sanitized observations. Exclude credentials, headers, raw HARs, audio payloads,
IP addresses, contact details, private endpoints, and unrelated content from saved
evidence. Record the public endpoint, selected model, fictional hint field, exact
byte/token accounting, source revisions, and resulting fictional text.

| Case | Action through the actual product | Required observation |
| --- | --- | --- |
| Feature off | Dictate into an existing draft with shared selection absent, then Stop and Undo. | Existing behavior and unrelated draft survive. No shared hints or automatic Send occurs. |
| Selected round trip | Select the accepted catalog through the real client and speak its fictional term. | Visible sources and disclosure, selected hints in the actual provider request, and a real final transcript in the correct draft. An unselected canary, disabled term, and wrong-locale term are absent. |
| Precedence and conflict | Use a personal override and two equal-priority shared aliases. | Accepted deterministic resolution, visible omitted conflict, and unchanged stored personal/shared data. |
| Bounds and unsupported route | Use exact-limit and next-over-limit input through the accepted provisioning/selection boundary. Exercise the accepted unsupported configuration. | Full encoded accounting and visible omission/refusal/unsupported status, with the draft preserved and no silent route change. |
| Admitted work and next request | Change catalog/policy through its accepted owner during a capture, let it settle, then start another. | Admitted work follows its pinned snapshot under actual transport ownership. New work uses current policy. No claim that sent hints were recalled. |
| Retry of the same attempt | If an accepted retry control exists, edit personal/shared data after capture and use it. | Fresh authority, accepted shared resolution, and the original P03 personal revision. An unavailable or forbidden pin requires visible refusal or explicit changed-version restart. A new recording does not prove this case. |
| Stop, discard, and authority | Separately exercise normal Stop, discard, destination retirement, and real retained-authority refusal. | Authorized final drain survives normal Stop. Discard/retired owners reject late publication. Verify the actual credential-dispatch, inbound-frame, and publication boundaries after the prerequisite lands. |
| Failure and recovery | Interrupt the supported provider/transport path in the controlled environment. Correct eligible text manually or explicitly record again. | Recoverable outcome, no unrelated draft loss, hidden replay, or automatic Send. Hinted text keeps its lineage. Old-audio retranscription remains unavailable without an accepted retained-audio owner. |
| Accessibility | Repeat selection, source inspection, conflicts, Stop/discard, recovery, and Undo using only the keyboard, then the named screen reader. | Actual focus, names, state announcements, reachable recovery, and preserved draft. An accessibility-tree dump alone is not a screen-reader trial. |

Separate transport acceptance from recognition benefit. Record paired shared-off/on
spoken trials with expected words, actual unedited provider text, endpoint/model,
microphone/browser/settings, and the accepted scoring rule. Include common words,
identifiers, negation, numbers, and literal spans. Preserve failures and ambiguous
results. One spelling success does not establish a general benefit.

Measure vocabulary preparation and user-visible latency at the accepted bounds.
Record hardware, serialized size, samples, warmups, allocations, and excluded
authentication/network/model costs. The earlier maximum-bound benchmark remains
historical evidence and cannot qualify a newly narrowed flow.

### Exercise the actual latest stable upgrade

The November 26, 2026 release lookup resolved
[latest stable v2026.11.10](https://github.com/openclaw/openclaw/releases/tag/v2026.11.10),
published November 25 at 12:42 AM ET, to commit
`6ea542fd97e2876aa4c871ccc494ed5419a03c5c`. Resolve latest stable again when running
this procedure. Record release/package integrity and candidate commit/tree/served
asset hashes separately. Both inspected source versions say `2026.11.10`, so a
matching version string does not identify the candidate build.

This is a manual stable-package-to-exact-candidate transition through canonical
startup. It does not prove managed-service update orchestration or automatic
launcher rollback. Keep both installations, state, browser profile, and recovery
data in the new allowed environment. Never open the same state with both Gateways.

1. Install the actual stable release into a task-owned prefix using its supported
   package-install procedure. Record artifact integrity and tool versions. Create
   valid settings, a draft, and personal vocabulary only through interfaces that
   actually exist in stable. If stable has no accepted personal-term store, record
   that missing lineage. Invented old database rows cannot prove compatibility.
2. Exercise stable feature-off dictation and supported personal behavior. Record
   each value's owner. Preserve the task browser profile for browser-local settings
   and drafts, which a Gateway backup alone does not cover.
3. Stop the task Gateway through its owner. Use the stable
   [backup and restore owner](/cli/backup) to create and verify a recoverable
   baseline. Keep credentials outside the fictional fixture where supported.
   Never export a backup, raw database, or config that contains credential-like
   values. Retain only sanitized receipts, hashes, and the data-owner inventory.
4. Start the built exact candidate with the same isolated state/config, using the
   foreground command above. Let canonical startup/migration owners handle data.
   Record refusal or failure honestly. Do not coerce schema versions or force
   Doctor repairs to manufacture a passing result.
5. Verify the served candidate, then reload the same browser profile. Confirm
   exact personal settings, draft contents, and any valid stable personal terms
   still load and work. Shared selection stays absent/off. No personal term becomes
   shared and no remote refinement or provider disclosure is enabled by upgrade.
6. Opt into the accepted shared flow separately and run the relevant product
   cases above. Test unsupported future schema through an accepted owner/import
   boundary in a separate disposable fixture. If no such boundary exists, leave
   that row NOT COLLECTED. Preserve original data and show the refusal/recovery
   outcome instead of declaring arbitrary future versions readable.

### Separate downgrade from baseline restoration

A direct downgrade tests whether stable can open candidate-written state. Run it
only when the accepted reader/schema contract permits it. A baseline restoration
starts stable from its verified pre-upgrade backup in a fresh recovery directory.
That proves recovery of the baseline only. It does not prove stable can read new
records or preserve candidate-only writes.

Use the canonical backup restore result and its actual manifest paths, perform
the documented offline activation checks, then verify personal and feature-off
behavior again. Keep browser-local recovery separate. Any retained collection
format, audit history, tombstone, migration, or deletion policy beyond the static
proposal needs separate acceptance before it can define rollback obligations.

Disabling future shared selection should prevent new shared work while already
admitted work follows its actual lifetime. Do not prescribe immediate vocabulary
lease invalidation as the new rollback policy. Existing transport refusals and
explicit discard still apply. No deployed feature switch exists in this prototype.

### Record results without closing unmet criteria

For every executed case, record the exact candidate and served assets, accepted
decision, environment, fictional input, start/end conditions, action, observed
result, and sanitized evidence. Label setup failures, product failures, missing
controls, and unrun proof separately. Link actual behavior and upgrade results
before claiming either review blocker is satisfied.

Current disposition: the decision and procedures are documented. Owner acceptance,
production selection/serialization, live provider/microphone/accessibility evidence,
new-scope performance, and real stable-to-candidate compatibility remain pending.
The original wider criteria remain open.

## Source checkpoints for this revision

These immutable sources explain the current gaps. They are source evidence, not
runtime qualification or acceptance of the proposed replacement contracts.

- [Talk create schema](https://github.com/CompleteDotTech/openclaw/blob/56aef23a43aea74de1f20ed6e1cf81cc3c1756a5/packages/gateway-protocol/src/schema/channels.ts)
  and [own-session classifier](https://github.com/CompleteDotTech/openclaw/blob/56aef23a43aea74de1f20ed6e1cf81cc3c1756a5/src/shared/session-method-scopes-base.ts).
- [Talk session authority](https://github.com/CompleteDotTech/openclaw/blob/56aef23a43aea74de1f20ed6e1cf81cc3c1756a5/src/gateway/talk/handlers/session.ts)
  and [relay publication/Stop owner](https://github.com/CompleteDotTech/openclaw/blob/56aef23a43aea74de1f20ed6e1cf81cc3c1756a5/src/gateway/talk/transcription-relay.ts).
- [WebSocket connection and inbound boundaries](https://github.com/CompleteDotTech/openclaw/blob/56aef23a43aea74de1f20ed6e1cf81cc3c1756a5/src/realtime-transcription/websocket-session.ts)
  and [OpenAI configured prompt serialization](https://github.com/CompleteDotTech/openclaw/blob/56aef23a43aea74de1f20ed6e1cf81cc3c1756a5/extensions/openai/realtime-transcription-provider-factory.ts).
- [Browser capture and transcript lifetime](https://github.com/CompleteDotTech/openclaw/blob/56aef23a43aea74de1f20ed6e1cf81cc3c1756a5/ui/src/pages/chat/composer-dictation-session.ts)
  and [file-audio cleanup](https://github.com/CompleteDotTech/openclaw/blob/56aef23a43aea74de1f20ed6e1cf81cc3c1756a5/src/gateway/talk/file-transcription.ts).
- [Trust model](/gateway/security/trust-model), [operator scopes](/gateway/operator-scopes),
  and [storage review checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes).
