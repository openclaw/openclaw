---
summary: "P03 personal dictionary design decisions, private groundwork, and incomplete acceptance evidence"
read_when:
  - Reviewing the proposed personal dictation dictionary
  - Choosing personal vocabulary persistence or provider hint boundaries
title: "Personal dictation vocabulary proposal"
---

# Personal dictation vocabulary proposal

This page records the P03 personal dictionary proposal and its acceptance evidence.
The current candidate contains private, pure vocabulary groundwork. **P03 is incomplete.**
It doesn't add a usable dictionary, persist entries, or send vocabulary to a provider.

## Review identity and dependencies

The selected lifecycle issue is [#205856](https://github.com/openclaw/openclaw/issues/205856).
It must remain open while any required criterion is unmet.

| Item                             | Recorded identity                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Original implementation base     | `openclaw/openclaw`, `main`, `1c3de7eb68481e5d7656e21ec96d43855789fbb0`                                                             |
| Task branch                      | `CompleteDotTech/openclaw`, `feat/personal-dictation-dictionary`                                                                    |
| Measured pure preparation commit | `46c74099c7360a4f8ecbfc556df9ba5cfa936903`. The PR records the final published head and subsequent checks.                          |
| Transport request                | [#191109](https://github.com/openclaw/openclaw/issues/191109)                                                                       |
| Shared vocabulary context        | [M06 #205820](https://github.com/openclaw/openclaw/pull/205820) and [#205633](https://github.com/openclaw/openclaw/issues/205633) |
| Refinement context               | [M11 #205845](https://github.com/openclaw/openclaw/issues/205845)                                                                   |

The owner proposal below was checked against main `cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2`.
This is a source-analysis pin, not a rebase or a tested product head.
The [P03 PR review](https://github.com/openclaw/openclaw/pull/205880#issuecomment-7188365505)
reviewed `9b8bba978eabe63170081bd5161c3f08b59d62cf` and found no actionable source defect.
It still requires a maintainer decision on the minimum flow and real behavior proof after acceptance.
That review does not qualify this later documentation revision.
M06 remains an open, unmerged draft at `56aef23a43aea74de1f20ed6e1cf81cc3c1756a5`;
its newer proposal is context, not the source revision reused below.

No accepted transport PR is asserted as a parent. The task branch started from the original implementation base.
An issue has no Git head to stack on.
P02 application context remains a sibling: personal terms must work without reading applications.
M06 owns future authorized shared overlays, and M11 would consume typed candidates and provenance.
Neither sibling's proposal establishes an accepted production contract for P03.

The candidate reuses three files from M06 commit `4780aeb034e72a6557f12a54ed506d5e4c690d98`:
`vocabulary-types.ts`, `vocabulary-terms.ts`, and `vocabulary-terms.test.ts`, under `src/realtime-transcription/`.
The types are unchanged. The term module exposes its comparison key and locale normalizer,
and extracts bounded raw JSON parsing for the personal import consumer.
It also resolves canonical precedence before alias conflicts, with a regression in the shared term tests.
The inherited bug let a shadowed shared entry's alias suppress an unrelated shared term after a personal override.
The personal import proposal also checks that a chosen replacement target matches the previewed conflict.
These are proposed source changes with unexecuted regressions, not an accepted or merged parent implementation.
No M06 store or lease implementation is required by the personal groundwork.
Any overlap with a later landed M06 change must be reconciled before publication or retargeting.

The three supplied P03 files were available. Local and Library searches didn't locate the complete planning package.
Its `IMPLEMENTATION_WORKFLOW.md`, `ARCHITECTURE.md`, `STACKING_PLAN.md`, `VALIDATION_PLAN.md`,
and `references/upstream-snapshot.json` therefore remain unread.
Missing package contracts must not be represented as implemented or verified.

## Decisions required before production integration

**Decision requested:** should P03 proceed with one profile-owned personal dictionary,
one manual Control UI editor, and one shared effective-vocabulary contract with M06?
The recommendation below makes that minimum concrete; it is **proposed, not accepted**.

The [issue review](https://github.com/openclaw/openclaw/issues/205856#issuecomment-7186791734)
and [PR review](https://github.com/openclaw/openclaw/pull/205880#issuecomment-7188365505)
request these owners and one usable editor-to-dictation flow.
No accepting maintainer decision was found in either discussion at the recorded review snapshot.
Contribution guidance requires separate acceptance for schema, durability, retention, permission,
or public-contract changes. See the [database review checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes).
Reusing a table without changing its database schema number does not accept a new durable interpretation.
This revision defines the proposal without registering a namespace, writing user data, adding a public interface,
or connecting the private helpers to production.

### Proposed personal owner and capacity

Use one preference value owned by the authenticated profile through existing `users.prefs.get/set`,
the profile resolver, and `src/state/user-preferences*` validation, worker, and store.
Reuse the existing profile-aware browser request/cache owner.
The server derives profile identity from the authenticated connection.
A proposed current-workspace partition must also be derived or validated by the actual target/workspace owner;
a browser-supplied workspace string or session key is not authority.
The preference namespace, envelope version, workspace mapping, and retention semantics are **NEEDS MAINTAINER**.
If that scope cannot be represented safely through the existing owner, keep hints transient pending a new decision.

| Boundary | Minimum proposal and existing constraint |
| --- | --- |
| Serialized value | At most 4,096 UTF-8 bytes for `JSON.stringify(value)`, including every workspace partition, IDs, revisions, locale, and schema metadata together. |
| Generic quotas | Keep the existing 32 entries per mutation and 128 generic keys per profile. Neither supplies extra capacity inside the dictionary value. |
| Concurrency | Use existing `expectedEntries` comparisons and atomic writes. A conflict or size rejection preserves the previous durable value and the editor's unsaved text. |
| Durable identity | `no_durable_identity` yields an unavailable, non-saving editor state. It does not create a browser-local durable substitute. |
| Profile merge | Existing target-key-wins behavior keeps the target's entire value when both profiles have the key. A source-only key transfers only if the target has capacity; source rows are then deleted, including skipped values. Accept this inherited behavior explicitly; do not promise term or partition union. |
| Recovery | Retain a minimal export/recovery path for the selected personal scope. Bulk catalog management is deferred, not recovery itself. |

These constraints come from the pinned
[preference constants](https://github.com/openclaw/openclaw/blob/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2/packages/gateway-protocol/src/schema/user-profile-constants.ts),
[validation](https://github.com/openclaw/openclaw/blob/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2/src/state/user-preferences.validation.ts),
[store and profile merge](https://github.com/openclaw/openclaw/blob/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2/src/state/user-preferences.store.ts),
and [authenticated handlers](https://github.com/openclaw/openclaw/blob/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2/src/gateway/server-methods/users.ts).
They establish available boundaries, not an implemented dictionary.

Set no fixed entry-count promise: actual capacity depends on exact strings and metadata.
The historical benchmark's 106,849-byte full input does not fit this value.
Do not shard terms into extra keys, increase generic limits, put a catalog inside a policy object,
or introduce a JSON sidecar to evade the selected limit.

### One manual editor-to-dictation flow

1. Start empty and off. An authenticated user explicitly enables personal vocabulary for the accepted current workspace.
   Add, edit, enable, disable, and delete exact Unicode spellings using stable opaque entry IDs.
   Renaming preserves identity. Initial dictionary selection is proposed as canonical `en-US` plus explicitly neutral entries;
   it does not imply endpoint language-code conversion or automatic neutral fallback.
2. Save through the existing preference owner with `expectedEntries`.
   Show a byte-cap error without discarding unsaved text.
   For a stale value, show an explicit reload/reapply choice; do not silently overwrite another window's changes.
   Ordinary document edits create no entries. Correction-to-entry learning and bulk import are deferred.
3. Start dictation through the existing `ComposerDictationOwner` and `ComposerDictationSession`.
   At the existing authenticated Gateway admission boundary, resolve one effective P03/M06 vocabulary snapshot
   before the microphone opens, with accepted scope, source revisions, deterministic selection, and omission reasons.
4. Use that immutable snapshot for the same admitted live request, including its internal transport reconnect or resumption.
   A genuinely new request or retry goes through normal current admission and takes the then-current snapshot.
   If a user retries or reprocesses with a different revision, identify that change explicitly.
   Preserve requester, target, cancellation, session-currentness, and effect guards; capturing once does not remove them.
5. Deliver transcripts through the existing ordered stopped-recording drain and shared `placeComposerDictation` path.
   Preserve live selection, IME, request generation, overlapping preview/late-final behavior, Undo, and uncertain-effect handling.
   Current main also preserves latched recording across blur/hidden-page events and bounds inserted text to
   the remaining draft `maxLength` with UTF-16-safe truncation. The dictionary must not introduce a second insertion path.

The pinned [composer owner](https://github.com/openclaw/openclaw/blob/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2/ui/src/pages/chat/composer-dictation.ts),
[session and placement owner](https://github.com/openclaw/openclaw/blob/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2/ui/src/pages/chat/composer-dictation-session.ts),
and [Talk admission handler](https://github.com/openclaw/openclaw/blob/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2/src/gateway/talk/handlers/session.ts)
supply those lifecycle boundaries. None currently consumes the personal helpers.

Disabling use preserves saved entries. Disabling or deleting an entry affects future admissions;
an already admitted live request retains its snapshot. Already disclosed provider data cannot be retracted.
Terms, correction pairs, and guessable hashes must remain absent from default diagnostics.

### Common contract with M06

P03 owns the personal lifecycle. M06 owns authorized workspace overlays and must not add another personal store.
Both feed one effective vocabulary at admission, using one shared validator/resolver and one combined provider budget.
The following is a proposed internal contract, not an accepted public SDK or final persisted schema:

| Concern | Proposed common rule |
| --- | --- |
| Text | Preserve canonical raw strings exactly. Use NFC only for comparison, with case-sensitive identity; do not fold accents, compatibility characters, or transliterations. |
| Identity | Keep stable IDs, source revisions, provenance, locale, and authenticated scope/source identity locally. Only canonical strings enter the selected provider hint field. |
| Precedence | Make personal-over-shared precedence explicit and conflicts visible. Resolve canonical precedence before any future alias collision index. |
| Selection | Filter enabled entries by accepted scope and locale, resolve precedence, apply deterministic ordering, then enforce aggregate provider term, byte, and token limits. |
| Budget | Personal and shared terms share the same budget. Existing configured prompt text and serialization overhead also count toward the actual endpoint limit; neither source gets a full independent quota. |
| Omission | Explain disabled, out-of-scope, locale-ineligible, unsupported, and over-budget terms without logging private text. Do not infer relevance from usage profiling. |
| Deferred fields | Aliases and pronunciation hints are omitted from this slice. Future aliases remain recognition candidates, never unconditional transcript replacements. |

M06's independent draft does not establish an accepted store, permission model, or mid-utterance revocation rule.
Reconcile the common contract before production wiring. Keep P02 application context optional and separate;
P03 must work without reading applications. M11 refinement is deferred until it has a separately accepted
derived-text disclosure contract.

### Provider boundary and qualifying proof

Propose one initial route through the existing OpenAI realtime **transcription** adapter's
`session.audio.input.transcription.prompt`.
The pinned [adapter](https://github.com/openclaw/openclaw/blob/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2/extensions/openai/realtime-transcription-provider-factory.ts)
captures normalized prompt, language, and model at session creation and sends the session payload on WebSocket `session.update`,
including reconnect. The
[auth helper](https://github.com/openclaw/openclaw/blob/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2/extensions/openai/realtime-provider-shared.ts)
also sends that payload to `POST https://api.openai.com/v1/realtime/client_secrets`
when an auth-profile key is used to mint a client secret.
That HTTP step is conditional; proof must cover each applicable disclosure path, not assume every connection uses both.

Accept the actual route and audio/derived-text disclosure contract with
[P04](https://github.com/openclaw/openclaw/issues/205852) before sending vocabulary.
An unsupported hint capability may continue ordinary dictation only on an already permitted route.
It must not silently choose a remote fallback or claim universal local-only enforcement.
The source field alone does not qualify a model, endpoint, token limit, language code, or recognition benefit.

After scope acceptance, qualify the real built and served `dist/control-ui`, Gateway admission, microphone,
selected provider payloads, and actual input placement/Undo at a recorded commit and served-asset identity.
Use matched no-dictionary, helpful-dictionary, and misleading-dictionary utterances, including unrelated names
and instruction-like strings. Measure actual payload limits, omissions, recognition, and full-turn timing.
Exercise two-window conflicts, account/workspace isolation, internal reconnect versus new retry,
keyboard/screen-reader behavior, and default logs/crashes/telemetry.
Upgrade, disable, unknown-version, and scoped recovery evidence must use the accepted durable format.
No such product proof was collected by this documentation revision.

### Acceptance decisions still needed

Maintainers need to accept the minimum feature, the preference namespace/version and workspace authority,
the total byte cap and inherited profile-merge lifecycle, the common P03/M06 precedence and budget contract,
and the permitted provider route. They must also accept any narrowing or deferral of the original criteria below.
An advisory review, this commit, and successful pure preparation do not supply that decision.
Canonical tests and real product proof follow acceptance; they remain merge gates.

## Private groundwork and its limits

The proposed pure boundary covers validation, personal import/export previews, bounded snapshots,
and provider hint data preparation. It has no production caller.
Its tests can establish deterministic behavior for supplied inputs, not authenticated storage or dispatch.

Canonical strings retain spelling, punctuation, accents, and case.
Normalized duplicate comparisons must not silently merge transliterations or distinct names.
Aliases remain recognition candidates. The proposal doesn't replace ordinary words such as "go" with "Go".
Instruction-like strings remain data and must never choose a route, invoke a tool, or supply a provider request object.

Snapshots need an immutable revision and explicit user/workspace identity from an authenticated caller.
Pure scope comparison isn't proof that the future caller authenticates that identity.
Edits apply to future admissions. Internal resumption of the same admitted live request retains its snapshot;
genuinely new requests and retries use normal current admission, with changed revisions disclosed.
Deleting an entry cannot retract hints already transmitted to an external service.

Capability and omission reporting must distinguish supported terms from unavailable aliases or pronunciation hints.
The existence of an SDK field doesn't prove endpoint acceptance, including for Google Live.
Actual provider integration and documented endpoint evidence remain necessary before advertising support.
Unsupported hints may leave ordinary dictation available only through an already permitted route, without a silent remote fallback.

## Acceptance ledger

Every original row remains required for P03. Tests are **NOT RUN**, and production completion is **BLOCKED**.
Passing a future pure test changes only its recorded evidence, not the completion status of the full criterion.

| Criterion                 | Groundwork and required production evidence                                                                                                                                     | Current status               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| AC01: atomic lifecycle    | Validate exact strings and identity. Still requires durable add/edit/disable/delete, stable IDs through rename, entry revisions, and atomic failure proof.                      | NOT RUN. Production blocked. |
| AC02: explicit learning   | Still requires confirmation showing recognition, canonical spelling, locale, and scope. Prove ordinary document edits create no entry.                                          | NOT RUN. Production blocked. |
| AC03: snapshots           | Exercise deterministic limits, neutral locale, omission reasons, and scope comparisons. Still requires capture integration and authenticated account/workspace isolation.       | NOT RUN. Production blocked. |
| AC04: supported hints     | Exercise pure hint-data preparation. Still requires real adapter payloads, unavailable-capability behavior, and endpoint-specific support evidence.                             | NOT RUN. Production blocked. |
| AC05: ambiguity           | Preserve candidates without replacements. Still requires no-dictionary, helpful-dictionary, and misleading-alias recognition evaluation.                                        | NOT RUN. Production blocked. |
| AC06: data isolation      | Exercise adversarial strings against pure data boundaries. Still requires proof through real dispatch/refinement that entries have zero route/tool effects.                     | NOT RUN. Production blocked. |
| AC07: conflicts/import    | Exercise invalid rows, duplicates, conflicts, and bounded previews. Still requires two-window conflict choices and atomic durable import with no partial corruption.            | NOT RUN. Production blocked. |
| AC08: future exclusion    | Exercise snapshot exclusion for deleted/disabled input. Still requires durable edits followed by new captures, without implying remote retraction.                              | NOT RUN. Production blocked. |
| AC09: retry revision      | Exercise immutable revision identity. Still requires capture-edit-retry and explicit reprocess behavior through the real turn lifecycle.                                        | NOT RUN. Production blocked. |
| AC10: local policy        | Exercise data-preparation policy choices. Still requires actual destination observation across transcription, refinement, retries, and diagnostics.                             | NOT RUN. Production blocked. |
| AC11: private diagnostics | Exercise content-free boundary errors. Still requires inspection of default logs, crashes, and telemetry for terms, correction pairs, and guessable hashes.                     | NOT RUN. Production blocked. |
| AC12: recovery            | Exercise versioned scoped export/import handling. Still requires accepted persistence migrations, upgrade/downgrade, unknown-schema recovery, rollback, and retained user data. | NOT RUN. Production blocked. |

### Proposed first-slice dispositions

This is a scope proposal for maintainer review, not a revision of the issue's accepted requirements.
**All twelve original criteria remain unmet.** Retained means the requirement stays in the first slice,
not that it has passed. Narrowed and deferred work remains outstanding unless maintainers accept the change.
The proposed allocation is five retained, six narrowed, and one deferred.

| Criterion | Proposed disposition | First-slice obligation and remaining scope |
| --- | --- | --- |
| AC01 | Narrowed | One manual Control UI editor with exact-text, stable-ID, atomic create/edit/disable/delete; broader client surfaces remain later work. |
| AC02 | Deferred | Defer the correction-to-entry UI. Retain the mandatory no-silent-learning rule now; any future learning requires explicit confirmation. |
| AC03 | Narrowed | Prove authenticated current-workspace and selected-locale isolation, deterministic selection, and bounded immutable snapshots on the chosen route. |
| AC04 | Narrowed | Qualify one actual provider/model/endpoint and every applicable disclosure path; broader provider capability support remains later work. |
| AC05 | Retained | Prove no unconditional replacement or unrelated insertion. Use misleading canonical hints in this slice; alias features and their evaluation remain deferred. |
| AC06 | Retained | Prove canonical strings remain inert through real dispatch, with no route or tool effects. Recheck refinement if M11 is later integrated. |
| AC07 | Narrowed | Prove manual atomic saves and two-window conflict choices. Bulk import/preview remains deferred; recovery still needs a supported path. |
| AC08 | Retained | Prove disable/delete excludes future admissions while preserving the snapshot of the same already admitted request. |
| AC09 | Retained | Distinguish internal resumption from a new admission; show any changed revision on user retry/reprocess. |
| AC10 | Narrowed | Prove no disallowed disclosure on the accepted P04 route and applicable retry paths. No universal local-only claim or M11 coverage is implied. |
| AC11 | Retained | Inspect default diagnostics for terms, correction pairs, and guessable hashes, including failure paths. |
| AC12 | Narrowed | Prove actual upgrade, disable, unknown-version preservation, and selected-scope recovery. Bulk catalog import/export and universal downgrade claims are deferred. |

## Evidence and recovery record

The execution host restarted during dependency preparation, removing the temporary checkout.
The candidate was reconstructed, independently reviewed again, and checkpointed remotely at
`c33bea090ef907fa150327dca65a9494b4142771`. Formatting and the exact test allocation were committed
at `46c74099c7360a4f8ecbfc556df9ba5cfa936903`. No result from the lost tree qualifies recovered bytes.

Two independent AI source reviewers inspected the recovered boundary and complete diff/ledger.
The complete review covered all twelve files. It found no unresolved correctness defect after
fixing the unrelated replacement target, shadowed-alias precedence, and first-duplicate representative.
The regressions are authored and reviewed, but **NOT RUN**. This is not maintainer approval,
local ClawSweeper/autoreview, or an executed integration review.

The author simplification pass retained one shared validator, locale normalizer, parser, and resolver.
There is no second state store, context collector, provider constructor, or production policy owner.
The first separable foundation is the M06 validation/resolution source, followed by personal consumers;
this draft cannot land as a complete P03 implementation. Net test growth is 1,078 lines, with an exact
678-line allocation beyond the existing 400-line allowance. The record covers distinct validation,
import, Unicode, scope, revision, ambiguity, and quota failures; it doesn't relax a threshold.

### Observed checks and setup limits

The original canonical test startup exited 137 before reporting any test cases.
After recovery, a separate frozen development-dependency installation using pinned pnpm 12.15.0,
CPU affinity to one logical CPU, and explicit native thread limits was also killed with exit 137.
These are setup failures, not assertion failures, passing tests, or proof of a specific OOM cause.

A small checkout-owned installation of the repository's exact `oxfmt` 0.74.0 and `tsx` 4.23.15 pins
supported formatting and the pure benchmark. It is not a complete project dependency installation.
The benchmark and test-line guard used the documented TSX preload with `PNPM_CONFIG_MODULES_DIR`
pointing to that local tooling directory. No borrowed checkout dependencies, alternate test runner,
modified setup, node_modules source patch, or disabled admission guard was used.

| Check                                                                     | Observed evidence and limits                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting                                                                | PASS: pinned oxfmt 0.74.0 checked all eleven changed TS/Markdown/config files, with one thread. This is a direct pinned-formatter check; the normal wrapper first failed because root dependencies were absent. |
| Whitespace                                                                | PASS: `git diff --check` over the scoped change.                                                                                                                                                                |
| Test-line ratchet                                                         | PASS: +1,078 lines, allowance 400, allocation credit 678. The exact recorded base was selected explicitly for the shallow checkout.                                                                             |
| Independent source review                                                 | Completed for all twelve reconstructed files, including the shared foundation and acceptance ledger. No unresolved correctness finding.                                                                         |
| Pure preparation benchmark                                                | PASS at `46c74099c7360a4f8ecbfc556df9ba5cfa936903`; measured distribution below.                                                                                                                                |
| Canonical term, personal snapshot, and import tests                       | NOT RUN. The required project dependency setup is incomplete.                                                                                                                                                   |
| Typechecks, lint, unused-file scan, full build                            | NOT RUN. No successful qualification is claimed from source review or the benchmark.                                                                                                                            |
| Documentation MDX sanity                                                  | BLOCKED at setup: the normal command could not load `@mdx-js/mdx`. No MDX pass is claimed.                                                                                                                      |
| Required CI and final published-head verification                         | The PR records the current head and actual workflow status; no CI pass is asserted here.                                                                                                                        |
| Recognition, microphone/provider, keyboard/screen reader                  | NOT RUN. No integrated dictionary UI or dispatch exists.                                                                                                                                                        |
| Actual local-only destination observation, log/crash/telemetry inspection | NOT RUN. Pure policy and numeric-summary helpers cannot establish production egress or privacy.                                                                                                                 |
| Upgrade/downgrade, atomic conflicts/import, rollback/recovery             | NOT RUN. No persistence contract or migration is activated.                                                                                                                                                     |

The canonical unit-src configuration still imports native runtime setup and UI config dependencies.
The new tests have no fast-lane membership; they were not routed through a different configuration.
The import module has no production caller and may be reported by the unused-file gate.
No ignore or artificial executable entry suppresses that pending integration concern.

### Measured pure preparation

The maintained entrypoint is:

```sh
node --import ./scripts/tsx.mjs scripts/bench-personal-vocabulary.mts
```

This measurement ran on an AMD EPYC 9V74 80-Core Processor host, Linux 6.18.57 x64,
Node 24.22.3 and V8 13.6.233.17-node.63. The environment exposed nine logical CPUs;
affinity limited this run to one available CPU. Host load averages were 0.51 / 0.63 / 0.99
both before and after the run. The recorded timestamp is 2026-11-26T09:15:53.020Z.

The deterministic synthetic workload has 1,000 entries, 950 enabled entries, and 334 aliases.
Each of neutral, en, en-US, es-ES, and fr-FR contributes 200 entries; selection uses en-US.
Serialized terms occupy 106,733 bytes and the full input 106,849 bytes.
The quota is a fixture: 64 terms, 8,192 JSON bytes, and 512 synthetic token units.
One term costs one fixture token unit; this is not a provider tokenizer or endpoint quota.

One first-call sample precedes 25 warmups and 200 serial samples. Percentiles use nearest rank.
The script checks that both snapshot and hint output contain exactly 64 terms after timing.
Validation, imports, persistence, authentication, microphone, network, and actual tokenization
are excluded. This establishes a local preparation baseline, not a speedup or full-turn latency.

| Stage                          | First call (ms) | Warm p50 (ms) | Warm p95 (ms) | Warm p99 (ms) | Warm max (ms) |
| ------------------------------ | --------------: | ------------: | ------------: | ------------: | ------------: |
| Snapshot                       |        9.482815 |      1.269420 |      1.679919 |      1.978188 |      6.980277 |
| Snapshot plus hint preparation |        9.886993 |      1.290653 |      1.797731 |      2.002955 |      7.004333 |

The observed warm snapshot p95 is below the proposed 50 ms target on this host.
Output occupancy is 64 terms, 1,089 JSON bytes, and 64 fixture token units.
The snapshot explains 50 disabled, 350 locale-ineligible, and 536 limit-omitted entries;
22 selected entries have aliases unrepresented by the canonical-only fixture.
No speech-quality, provider support, browser accessibility, or real microphone claim follows.

## Proposed rollout and recovery

No rollout or user-data migration is activated by this candidate.
The eventual feature should begin empty and opt-in, without mining instructions, contacts, or previous edits.
Disabling dictionary use should stop new hint injection while preserving saved entries.
The audited source identified no shipped personal-dictionary schema to migrate.
Unmerged P03/M06 draft fields are not a released migration source.
If an explicit shipped vocabulary setting is later found, define a previewable migration preserving exact text and scope.

Keep a minimal export/recovery path even though bulk catalog import/export is deferred.
Exports should contain only the selected personal scope and warn that names and terminology can be private.
Unknown versions must preserve recoverable bytes without injecting or silently rewriting them.
If an unknown envelope cannot be projected safely to the selected scope, block that export and require
an accepted recovery owner/path; do not expose other workspace partitions to manufacture a recovery claim.
Accept profile-merge loss semantics explicitly before enabling the proposed preference value.

Rollback should stop new hint injection without deleting entries or changing unrelated preferences.
Qualify an actual stable-to-candidate upgrade and the supported disable/recovery path.
Do not imply universal downgrade compatibility from a version field or the pure import/export helpers.
Those behaviors need implementation and evidence before AC12 can pass.

## Remaining review risks

The largest gap is the absent production path: pure functions cannot demonstrate the requested user outcome.
Missing package specifications and unresolved maintainer decisions also prevent treating proposed contracts as accepted.
Keep the lifecycle issue open and any review PR explicitly incomplete until those gaps are resolved.

Keep subsequent changes within the existing draft and recheck equivalent work before expanding scope.
Verify the tested and pushed heads match, disclose reused source, and keep the visible diff accurate.
The historical evidence above remains tied to its recorded commits; this documentation revision
does not rerun or transfer those checks to a new head. Its bounded text checks and `git diff --check`
do not qualify canonical Markdown formatting, lint, MDX compilation, or published link/anchor validation.
Those canonical checks remain NOT RUN because the required tooling is unavailable in this environment;
no contributor repository code was executed or dependency setup changed for this revision.
Use a related issue reference while acceptance criteria remain unmet. This task doesn't authorize an upstream merge.
