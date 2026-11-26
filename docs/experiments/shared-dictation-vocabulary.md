---
doc-schema-version: 1
summary: "M06 shared dictation vocabulary prototype, ownership decisions, acceptance gaps, and evidence boundaries"
read_when:
  - "Reviewing shared dictation vocabulary authorization and storage proposals"
  - "Qualifying vocabulary hints, revocation, or collection management"
title: "Shared dictation vocabulary experiment"
---

# Shared dictation vocabulary experiment

**Status: prerequisite prototype; M06 is incomplete.** The implementation contains
internal vocabulary validation, resolution, collection operations, snapshot leases,
and an optional guard at the existing Talk transcription relay. It does not enable
shared dictionaries for a production installation. There is no accepted collection
permission mapping, production store registration, collection RPC or management UI,
qualified provider adapter, or complete P03/M11 integration.

The selected issue is [openclaw/openclaw#205633](https://github.com/openclaw/openclaw/issues/205633).
It remains open. [Issue #191109](https://github.com/openclaw/openclaw/issues/191109)
is adjacent transcription-hint work; it is neither the implementation's parent nor
proof of shared authorization or provider acceptance. P03, M06, and M11 are local
design identifiers from the supplied dictation package, not upstream PR numbers.

| Review identity            | Recorded value                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation source base | `openclaw/openclaw:main`, `04b854b239cd8ab8a14beae4914ed9c54d791e62`                                                                                                                                                                |
| Published fork branch      | `CompleteDotTech/openclaw:feat/dictation-shared-dictionaries`                                                                                                                                                                       |
| Accepted P03 or M11 parent | None identified in the inspected base                                                                                                                                                                                               |
| Tested implementation head | Exact commit and source hashes are recorded in the accompanying `validation-receipt.json`; the PR body must identify its published head.                                                                                            |
| Upstream review draft      | [openclaw/openclaw#205820](https://github.com/openclaw/openclaw/pull/205820); exact current head/base and CI state are recorded in the PR and validation receipt. Production integration/readiness still require design acceptance. |

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

The supplied `IMPLEMENTATION_PROMPT.md`, `ISSUE.md`, `PR.md`, `ARCHITECTURE.md`,
`IMPLEMENTATION_WORKFLOW.md`, and `VALIDATION_PLAN.md` require all twelve acceptance
criteria. A foundation or a passing fixture cannot close the full feature issue.

## Existing owners and missing contracts

| Responsibility                            | Existing owner                                                                                                         | M06 boundary and remaining decision                                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated people                      | `src/state/user-profiles.ts`, `user-profiles-owner.ts`, and `user-profile-list.ts`                                     | Reuse canonical identities. A profile or connected Gateway alone does not authorize a dictionary.                                                                                                                                                                   |
| Operator roles and project access         | `src/gateway/operator-role-policy.ts` and `src/gateway/project-access.ts`                                              | Host policy must map dictionary read, edit, manage, export, and provider disclosure to accepted scope permissions. Existing project access is not automatically confidential collection membership.                                                                 |
| OpenClaw ID authority                     | `src/gateway/openclaw-id/authority.ts`, `claw-store.ts`, and `tunnel-principal.ts`                                     | Existing principal/membership invalidation can inform an accepted host mapping; the vocabulary package does not recreate those identities or maintain a membership database.                                                                                        |
| Plugin request authority                  | `src/plugin-sdk/gateway-request-authority.ts` and `src/plugins/runtime/gateway-request-scope.types.ts`                 | The inspected `GatewayRequestAuthorityV1` exposes current request authority and person attribution, but no accepted dictionary/workspace membership capability. A plugin must not infer it from a scope string or import private Gateway policy to manufacture one. |
| Durable plugin state                      | `src/plugin-state/plugin-state-store.ts`, its types, and `src/plugin-sdk/plugin-state-store-runtime.ts`                | Use the existing worker-backed V2 store and action-bound authority. Namespace, retention, quota, and collection representation still require acceptance.                                                                                                            |
| Speech session and transcript publication | `src/gateway/talk/handlers/session.ts` and `src/gateway/talk/transcription-relay.ts`                                   | Keep transcription in the existing `mode: "transcription"`, `brain: "none"` owner. The optional lease guard does not create a recognizer or insertion owner.                                                                                                        |
| Browser dictation                         | `ui/src/pages/chat/composer-dictation-session.ts`, `composer-dictation.ts`, and `composer-direct-dictation.ts`         | Existing clients remain their own capture/draft owners. This prototype adds no collection picker, accessible management, source inspector, or recovery controls.                                                                                                    |
| Provider capabilities                     | `src/realtime-transcription/provider-types.ts`, `provider-contexts.ts`, and `src/plugins/capability-provider.types.ts` | An accepted adapter must supply verified hint fields and exact budgets. No production provider advertises this prototype's vocabulary capability.                                                                                                                   |
| Personal vocabulary and refinement        | P03 and M11 proposed contracts                                                                                         | Neither accepted contract was located in the inspected base. New internal vocabulary types are a minimal proposed prerequisite, not a claim that P03 or M11 is complete.                                                                                            |

[Operator scopes](/gateway/operator-scopes) describe collaboration within a trusted
Gateway domain. Project/source access also covers broader use cases than private
dictionary membership. Reusing either surface without an explicit mapping would
silently change its confidentiality meaning. The host must own that decision and
provide live revocation, expiry, and provider-disclosure grants. With no such
authority, shared collection operations fail before opening storage.

The [storage review checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes)
requires recorded design acceptance for public contracts, schemas, retention,
durability, and permission changes. A new JSON representation in an existing table
does not avoid that checkpoint. An upstream draft may present the proposal for
design discussion without claiming acceptance or enabling these contracts. Issue #205633 records the proposed feature; filing
it does not constitute acceptance. The present code is unregistered and introduces
no SQL schema, personal-store migration, plugin SDK export, or public RPC.

## Implemented internal boundaries

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
A documentation review on November 26, 2026 checked the existing OpenAI adapter
against the [current client-event reference](https://developers.openai.com/api/reference/resources/realtime/client-events).
Its `session.audio.input.transcription.prompt` is documented as optional free-form
context for the adapter's `gpt-4o-transcribe` default, excluding diarization.
The existing fake-WebSocket provider test checks configured prompt serialization;
it does not establish live acceptance. The [archived November 2025 Cookbook](https://developers.openai.com/cookbook/examples/realtime_out_of_band_transcription)
mentions a 1,024-token limit but warns its API information may be outdated. The
exact current token, byte and term budgets therefore remain unverified. Neither
source qualifies a 5,000-term/400-KiB provider payload. The [deprecation table](https://developers.openai.com/api/docs/deprecations)
also schedules the current default model's shutdown for February 26, 2027;
provider-owner migration and live qualification remain separate required work.
No provider route is selected from term text and no alternative route is attempted.
The lease currently binds one provider/capability to both nominal stages. It does
not qualify differing STT and refinement endpoints or their distinct budgets; that
requires the accepted M11/provider integration.

### Hinted STT lineage and recovery

Prepared egress carries snapshot ID, stage, provider, and whether the result is
shared-derived. Refinement inherits prior shared STT lineage even when it adds no
new shared hint. The optional Talk relay guard rejects stale, wrong-provider, or
wrong-stage admissions; checks current authority for audio and callbacks; requests
session closure after invalidation; and checks publication before transcript
events. Provider error messages are redacted for vocabulary-bound sessions.

This connects the prototype to an existing publication owner, but no production
session handler constructs the lease or sends its hints through a qualified
adapter. M11's full generation, refinement, final acceptance, and insertion
coordination remains absent. The host must make every relevant permission change
observable to `assertCurrent` and invalidation subscribers before publication.

A newly arriving result from hinted STT cannot become a supposedly independent raw
fallback after revocation. Already accepted user-owned material remains under its
existing policy; cancellation cannot undo an earlier publication or recall a
request already sent to a provider. `vocabularyRecovery` describes manual recovery
when permitted audio is absent, or an explicit new transcription when the caller
already has policy-permitted retained audio. It records no audio, starts no retry,
and performs no insertion. Actual recovery controls and the retained-audio policy
integration are blocked; the descriptor is not a working retranscription flow.

## Acceptance and evidence ledger

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

| Criterion                        | Status  | Production owner and current coverage                                                                                                                                        | Missing proof                                                                                                                                                                                             | Artifact / tested head                                |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| AC01 — Authorized scope          | PARTIAL | Host authorization plus collection/snapshot owners; E1/E3 fail closed and bind requested scopes to grants.                                                                   | Accepted real membership/ACL mapping, store opener, RPC, guessed-ID matrix against those production boundaries.                                                                                           | E1/E3; observed focused run; receipt head             |
| AC02 — Resolution                | PARTIAL | Proposed P03 resolver; E2 checks session/personal/shared precedence and unresolved conflicts.                                                                                | Accepted P03 integration, real private personal lifecycle, visible selection/source/conflict UI.                                                                                                          | E2; observed focused run; receipt head                |
| AC03 — Provider contract         | PARTIAL | Provider adapter owner; E2/E3 bound synthetic canonical-list hints and expose unsupported/truncated status.                                                                  | Verified endpoint fields, tokenizer/payload limits, actual authorized transport, visible capability disclosure, refusal without rerouting.                                                                | E2/E3/E7; live proof NOT RUN                          |
| AC04 — Revocation                | PARTIAL | Host authority, snapshot owner, existing Talk relay, future M11/M10; E3/E4 cover hinted lineage and late-result rejection.                                                   | Production membership invalidation, actual hint dispatch/refinement/insertion races, explicit authorized retranscription and no-audio UI recovery.                                                        | E3/E4/E5/E7; observed focused run; receipt head       |
| AC05 — Concurrent edits          | PARTIAL | V2 store owner and collection service; E1/E8 cover CAS, complete-import rejection, tombstones, uncertain receipts, and actual worker reopening.                              | Accepted production namespace/authority mapping and real management conflict recovery.                                                                                                                    | E1/E8 observed; production client proof NOT RUN       |
| AC06 — Migration                 | PARTIAL | Existing store/migration owner; prototype preserves unknown versions and limits export to one authorized draft.                                                              | Accepted migration/rollback/retention contract and actual saved-state upgrade/downgrade proof; no P03 migration exists here.                                                                              | E1/E7; migration NOT RUN                              |
| AC07 — Offline lifecycle         | PARTIAL | Host authority and utterance owner; E1/E3 reject expired/disconnected grants and require fresh work after reconnect.                                                         | Real connectivity changes, visible unavailable state, accepted personal-only path, retry/reconnect integration.                                                                                           | E1/E3/E7; client proof NOT RUN                        |
| AC08 — Isolation                 | PARTIAL | Validator, capability adapter, route owner; E2 rejects malformed imports and keeps hostile text in a data list.                                                              | Qualified adapter encoding, real no-tool/no-mode/no-route behavior, cross-scope transport inspection.                                                                                                     | E2/E4/E7; live proof NOT RUN                          |
| AC09 — Accessibility and clients | BLOCKED | Existing browser/native client owners.                                                                                                                                       | Collection selection/management, source inspection, conflicts, recovery, keyboard and supported screen-reader trials.                                                                                     | E7; NOT RUN; no UI added                              |
| AC10 — Privacy                   | PARTIAL | Collection, snapshot, relay, store and diagnostic owners; E1/E3/E4/E8 separate audit/export, retain minimized worker records, and redact vocabulary-bound provider failures. | Accepted audit visibility/retention, real telemetry/cache/admin/export review, production resource lifecycle proof.                                                                                       | E1/E3/E4/E8; observed runs; receipt head              |
| AC11 — Performance               | PARTIAL | Validator/resolver, store and adapter owners; bounds are encoded; E8 verifies an exact maximum draft with full audit fits the actual store value quota.                      | A repeatable below-50-ms target (the refreshed compact case misses it), cumulative allocation instrumentation, production resource proof, and actual provider quotas. Synthetic timing results are below. | E2/E6/E8; observed benchmark/store runs; receipt head |
| AC12 — Semantic regression       | PARTIAL | P03, provider, and future M11 validation owners; E2 preserves exact spelling and performs no transcript substitution.                                                        | Spoken common-word/identifier/negation/number/literal corpus, real hinted recognition, and unaffected personal-only dictation.                                                                            | E2/E7; spoken/client proof NOT RUN                    |

### Observed local verification

Refreshed qualification on November 26, 2026 uses this checkout's own physical,
complete workspace installation, reconciled with frozen lockfile and pinned pnpm
12.15.0. The dependency supply-chain check passed for 1,764 packages. Tests use the
repository's `run-vitest.mjs` wrapper, installed patched Vitest, Node 24.22.3,
standard project configurations, one worker, and the supported throttled mode.
Commands, logs, source hashes, and the final published-head mapping are retained
with the validation receipt.

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
| Required CI                                                                       | NOT RUN to completion. At qualification head `70bac82c4c24bded28615002d52701940ee3494a`, [CI](https://github.com/openclaw/openclaw/actions/runs/45773743254) reports `action_required` with zero jobs; [Proof](https://github.com/openclaw/openclaw/runs/139752289972) is skipped. PR context/evidence passed, which is not build/test proof. Current-head status is recorded in the PR/receipt.                                                       |
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

Reproduce the benchmark after installing the normal repository dependencies:

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

No existing dictionary data is migrated and no production namespace is opened by
this prototype. The proposed initial activation is explicit collection selection
with personal precedence and current online authority. It must never discover
personal terms and publish them as an upgrade step.

An accepted rollout needs a versioned namespace/representation decision and a
bounded, idempotent, scope-preserving migration owned by the existing store. Use
actual supported saved state for upgrade and rollback tests. Unknown collection
versions must remain intact; neither an older binary nor an import may reinterpret
them as an empty collection. Backups inherit the owning store's access and
retention policy; exporting a draft does not substitute for a consistent backup.

The proposed rollback is to disable shared resolution at its eventual registration
point, invalidate active leases, and stop new disclosure while preserving personal
records, collection rows, and tombstones. No deployed feature switch is added in
this prototype. Destructive downgrades, tombstone deletion, or altered retention
need a separately accepted migration/recovery plan. Already accepted documents
and already dispatched provider requests retain their existing policy and truthful
outcome; rollback does not claim to erase or recall them.

Before enabling the feature, complete the following dependencies:

1. Accept P03's common term/protection/provider contract and the host collection
   permission, provider-disclosure, store namespace, and retention mapping.
2. Bind the accepted grants to real V2 worker operations; prove production
   authorization, CAS settlement, unknown outcomes, quotas, and restart behavior.
3. Integrate one snapshot into the existing speech owner and accepted M11
   generation/result lifecycle, including final publication and explicit recovery.
4. Qualify each advertised provider's actual endpoint, encoded limits, hostile-data
   handling, failure route, and spoken semantic corpus.
5. Implement and test collection selection, management, sources, conflicts,
   unavailable state, and recovery on each advertised client.
6. Record final measured evidence and required review/CI against the published
   head. Keep issue #205633 open until its agreed complete scope is satisfied.

Browser Control UI consumption and management are both unqualified. Native,
mobile, remote, and headless clients are likewise unqualified. Existing dictation
support on those surfaces is not evidence of shared-vocabulary support. The
internal prototype can inform the accepted integration without advertising a
complete client, offline, system-wide insertion, or provider capability.
