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
| Base                             | `openclaw/openclaw`, `main`, `1c3de7eb68481e5d7656e21ec96d43855789fbb0`                                                             |
| Task branch                      | `CompleteDotTech/openclaw`, `feat/personal-dictation-dictionary`                                                                    |
| Measured pure preparation commit | `46c74099c7360a4f8ecbfc556df9ba5cfa936903`. The PR records the final published head and subsequent checks.                          |
| Transport request                | [#191109](https://github.com/openclaw/openclaw/issues/191109)                                                                       |
| Shared vocabulary context        | [M06 #205820](https://github.com/openclaw/openclaw/issues/205820) and [#205633](https://github.com/openclaw/openclaw/issues/205633) |
| Refinement context               | [M11 #205845](https://github.com/openclaw/openclaw/issues/205845)                                                                   |

No accepted transport PR is asserted as a parent. The task branch uses the recorded main commit.
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

Maintainer acceptance for personal persistence and public contracts is outstanding.
The [automated issue review](https://github.com/openclaw/openclaw/issues/205856#issuecomment-7186791734)
also requests a coordinated storage owner, minimum client flow, and shared term contract with M06.
That advisory review is not maintainer design acceptance. No accepting maintainer decision was found.
Contribution guidance requires separate design acceptance for schema, durability, retention, permission,
or public-contract changes. See the [database review checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes).
The candidate doesn't introduce a preference namespace, RPC, public SDK export, dictionary editor,
provider dispatch change, or migration while those decisions remain unresolved.

Current source provides useful boundaries, but no accepted dictionary storage contract:

| Existing boundary         | Source finding and consequence                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authenticated preferences | `src/gateway/server-methods/users.ts` owns the `users.prefs` entry points. Production dictionary access must use authenticated identity, not a caller-supplied user ID as authority.                                                                                           |
| Durable preference writes | `src/state/user-preferences.validation.ts`, `user-preferences.store.ts`, and the worker implement validation and expected-value comparisons. A new dictionary must reuse the accepted state and transaction conventions.                                                       |
| Preference capacity       | `packages/gateway-protocol/src/schema/user-profile-constants.ts` allows 4 KiB per value, 32 entries per mutation, and 128 generic keys per profile.                                                                                                                            |
| Browser preference reads  | `ui/src/app/user-prefs-request.ts` and `user-prefs-cache.ts` own profile-aware cached reads and invalidation. A dictionary must not introduce a competing account cache.                                                                                                       |
| Capture lifecycle         | `ui/src/pages/chat/composer-dictation-session.ts` owns `ComposerDictationSession`. Production integration must pin the vocabulary before microphone capture and carry that revision through retries.                                                                           |
| Existing hint fields      | `extensions/openai/realtime-transcription-provider-factory.ts` already constructs an OpenAI transcription `prompt`. `extensions/deepgram/audio.ts` handles batch `keyterm` values. Neither proves this dictionary is connected or that every endpoint accepts the same fields. |

A 1,000-entry dictionary doesn't fit in one 4 KiB preference value.
Using one preference key per term exceeds the profile limit.
Sharding or changing limits needs an explicit storage design, including atomic import and recovery.
This candidate doesn't bypass those limits or create a JSON sidecar store.

Maintainers still need to accept these concrete decisions:

1. Choose a personal persistence surface and its migration, downgrade, and recovery behavior.
2. Define authenticated user/workspace scope, stable entry identity, revision checks, and deletion semantics.
3. Accept entry/import limits and the provider capability contract. Private constants aren't public API acceptance.
4. Identify the selected egress policy and its enforcement in transcription, refinement, and retries.
5. Choose the editor and correction-confirmation surface, including conflict and import-preview interactions.
6. Confirm M11's typed input and M06's future overlay boundary without introducing another store.

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
Edits should apply to later captures, and retries should retain their original snapshot.
Deleting an entry cannot retract hints already transmitted to an external service.

Capability and omission reporting must distinguish supported terms from unavailable aliases or pronunciation hints.
The existence of an SDK field doesn't prove endpoint acceptance, including for Google Live.
Actual provider integration and documented endpoint evidence remain necessary before advertising support.
An unsupported provider must continue ordinary dictation.

## Acceptance ledger

Every row is required for P03. Tests are **NOT RUN**, and production completion is **BLOCKED**.
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
Any discovered explicit vocabulary setting needs a previewable migration that preserves exact text and scope.

Exports should contain only the selected personal scope and warn that names and terminology can be private.
Unknown schema versions should preserve recoverable bytes and offer a recovery/export path.
Rollback should stop hint injection without deleting entries or changing unrelated preferences.
Those behaviors need implementation and upgrade/downgrade evidence before AC12 can pass.

## Remaining review risks

The largest gap is the absent production path: pure functions cannot demonstrate the requested user outcome.
Missing package specifications and unresolved maintainer decisions also prevent treating proposed contracts as accepted.
Keep the lifecycle issue open and any review PR explicitly incomplete until those gaps are resolved.

Before publication, recheck the current per-author PR limit and equivalent work.
Verify the tested and pushed heads match, disclose reused source, and keep the visible diff accurate.
Use a related issue reference while acceptance criteria remain unmet. This task doesn't authorize an upstream merge.
