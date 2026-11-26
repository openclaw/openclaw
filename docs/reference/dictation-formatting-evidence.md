---
doc-schema-version: 1
summary: "M04 acceptance ledger, reproduction procedures, and outstanding qualification for dictation formatting"
read_when:
  - You are reviewing the dictation formatting implementation
  - You are collecting semantic, lifecycle, accessibility, or target evidence
title: "Dictation formatting evidence"
---

This is the acceptance ledger for
[issue #205634](https://github.com/openclaw/openclaw/issues/205634). M04 and M11 are
local planning identifiers, not additional GitHub issue numbers. The
[user guide](/web/control-ui-dictation-formatting) describes the supported grammar
and delivery boundaries.

**Evidence state: review draft with partial verification.** All 295 focused cases
have passed across 13 suites, including the actual dictation owner, session,
adapters, and review components. The final combined run passed 294 cases; after
correcting an obsolete capture-state trigger in one test, its complete 34-case
suite passed on rerun. Required full-UI types, production build, browser, real
microphone, native rich-editor, and assistive-technology proof remains blocked or
NOT RUN. A passing synthetic test does not qualify those external boundaries.

## Revision and environment record

| Field                                            | Recorded value                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implementation branch                            | `feat/dictation-semantic-formatting`                                                                                                                                                       |
| Checkout base                                    | `04b854b239cd8ab8a14beae4914ed9c54d791e62`                                                                                                                                                 |
| Final tested head                                | The companion evidence manifest records the final commit, tree, and source hashes; the PR must repeat the exact pushed head. Checks below identify any earlier inputs.                     |
| Published PR and pushed head                     | NOT RECORDED in this source document. Publication requires authenticated access to the contributor's fork; the PR and companion manifest are the external head binding.                    |
| OS, browser/app build, Node/Bun, CPU/RAM         | Linux 6.18.57; Node 24.22.3; Intel Xeon Platinum 8573C; 9 logical CPUs; 10,451,423,232 bytes RAM. No browser launched: pinned Chromium revision 1248 was unavailable.                      |
| Microphone, STT provider/model, locale and route | NOT RECORDED — a synthetic transcript does not fill this row.                                                                                                                              |
| Build, CI run, and artifact URLs                 | Production build BLOCKED by exit 137 at chunk rendering after 5,711 modules transformed. CI NOT RUN before publication. Local artifact names are listed below; upload URLs remain pending. |
| Maintainer design acceptance                     | Pending in the linked issue for the private contract, browser preference, initial grammar/formats, and resource limits.                                                                    |

Bind every result to its tested commit. After integration, rebasing, or review
fixes, identify which proofs remain valid and rerun affected boundaries. Do not
replace a failed or blocked observation with the existence of a test file.

## Acceptance ledger

| Criterion                                     | Implementing boundary                                                          | Required proof                                                                                                                                                       | Observed outcome / remaining proof                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M04-AC01: policy and baseline                 | `settings-contract.ts`, `settings.ts`, `ComposerDictationOwner`, mode controls | Preserve before/after upgrade; Explicit opt-in; unsupported policy; reprocess without changing prior drafts                                                          | PASS: 14 settings cases, including prior-record read, same-state opt-in/rollback, unsupported policy and retained draft bytes. Production upgrade/downgrade journey NOT RUN.                                                                                     |
| M04-AC02: lexical and structural invariants   | `ui/src/lib/dictation/{types,grammar,document,formatting}.ts`                  | Shopping list; paragraphs and hard breaks; nested lists; repeated/skipped numbers; negation, quantities, names, RTL and protected bytes; compare all representations | PASS: relevant cases in 33-test semantic suite; independent Markdown parser compares order, explicit labels and literal text. Real recognition fidelity NOT RUN.                                                                                                 |
| M04-AC03: literal markers and reviewed intent | Grammar, source-backed marker validation, confirmation checklist               | Ordinary discussion and quoted/code markers stay literal; bare paragraph fixture needs exact reviewed marker confirmation; changed source retires confirmation       | PASS: semantic and review-component suites, including plural “bullet points,” quoted/code protection, exact-range confirmation and replacement-preparation reset.                                                                                                |
| M04-AC04: bounded validation                  | `validateDictationDocument`, preparation fallback                              | Unknown versions/nodes; cycles; duplicate/lost/reordered text; invalid grapheme offsets; protected whitespace; excessive counts/depth; bounded malformed mutations   | PASS: malformed structure/source-map and bounded mutation tests. Proposed ceilings still require maintainer acceptance and broader corpus qualification.                                                                                                         |
| M04-AC05: deterministic safe rendering        | `renderDictationDocument`, semantic preview                                    | Independent CommonMark parsing; allowlisted HTML parsing; delimiters, hostile markup, URLs and zero external resource loads                                          | PASS: independent markdown-it and parse5 checks; all output comes from one validated value. Browser resource-request observation BLOCKED by unavailable Chromium.                                                                                                |
| M04-AC06: capability-selected representation  | `composer-dictation-formatting.ts`, main/direct adapters                       | Real plain field and declared Markdown composer; full-draft selection guard; changed/unknown capability; rich preparation distinguished from delivery                | PASS: capability, owner, and actual direct-adapter/component tests, including readonly, focus loss, edit-then-restore, and unknown targets. Actual browser plain/Markdown proof BLOCKED. Native rich insertion/undo BLOCKED: no qualified M10 adapter or editor. |
| M04-AC07: lifecycle and at-most-once recovery | `composer-dictation.ts`, `composer-dictation-session.ts`, adapters             | Finalization deadline; duplicate/late events; edits; focus and A→B→A scope/policy changes; cancel/reprocess; unknown effect without retry                            | PASS: final 47-case baseline owner and 34-case review suites, including synchronous stop reentrancy and incomplete-result reprocessing; four history cases cover post-focus revocation and unknown effect without retry.                                         |
| M04-AC08: inert text delivery                 | Reviewed placement, editor history bridge, Send controls                       | Accepting text creates one undoable edit and no send, command, attachment, action-key event, or fallback write                                                       | PASS: one-attempt/no-retry history contract and main/Side chat/New Session submission regressions. Actual browser Undo and complete browser no-Send journey BLOCKED; native execution/attachment claims are limited to the implemented inert adapters.           |
| M04-AC09: accessible review                   | `components/composer-dictation-formatting.tsx`, status and control integration | Real keyboard journey, stable screen-reader status/list semantics, focus return, high contrast, 400% zoom and large text                                             | PASS: eight review-component cases and seven actual owner/adapter/Solid view cases, including focused Finish removal and eligible focus return. Browser layout/keyboard proof BLOCKED. Actual screen reader and browser-chrome 400% zoom NOT RUN.                |
| M04-AC10: upgrade, privacy and resources      | Existing browser settings owner; transient review; bounded formatter           | Same-state upgrade/rollback; unrelated preference/draft preservation; provider routing/egress evidence; named-hardware latency and memory                            | PASS: settings fixtures and measured validation/render p95 (21.880/14.926/34.074 ms). Full preparation, first-call, memory and external-latency limits are reported separately below.                                                                            |

Required initial scope includes paragraphs, line breaks, unordered/ordered lists,
the accepted nested depth, and plain/Markdown/rich preparation with truthful
delivery qualification. Headings, tables, and inferred Suggest structure remain
optional. The required rich-editor demonstration is still open when no qualified
adapter/device is available; it must not disappear from the completion ledger.

## Minimal neutral lifecycle prerequisite

The implementation extends the existing composer dictation owner and transcription
session. It must not introduce a second provider, capture owner, transcript store,
or public RPC merely to imitate the M11 proposal. Its private generation contract
must retain capture identity, original transcript revision and finality, immutable
policy, source ranges, target/selection/capability facts, and cancellation/deadline
eligibility through preparation and reprocessing.

The deterministic formatter is the only enabled refinement stage. Optional
cleanup, correction, context, vocabulary, and model-assisted processors are not
implemented by this contribution. No assertion is made that their wider M11
acceptance criteria are already satisfied. Future integrations must preserve the
same source map and currently valid provenance rather than adding renderer-local
rewrites or publishing a revoked context-derived fallback.

Delivery retains a separate `not-committed`, `committed`, or `outcome-unknown`
receipt. Cancellation after an attempted indivisible effect cannot reset that
receipt or authorize a retry. Finalized transcript evidence, preparation success,
and insertion evidence are three different observations.

## Focused automated procedures

Use the checkout's routed test runner with one worker. Executed focused results
are recorded here; the remaining commands are procedures, not implied passes:

| Check                                                                          | Observed result                                                                                                                                                                      | Artifact                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Final focused behavior batch                                                   | 294 PASS / one test-trigger failure across 13 suites, 16.44 s Vitest / 20.05 s wrapper. The failing test used the old read-only state to detect idle; its assertions were unchanged. | `m04-final-tests.log`                                                                         |
| Corrected review lifecycle suite                                               | 34/34 PASS after changing that trigger to recording activity, 3.07 s Vitest / 5.71 s wrapper. Together with the unchanged other 12 suites, all 295 distinct cases pass.              | `m04-review-final-tests.log`                                                                  |
| Final editor history guard                                                     | Four cases PASS after the final API-capability guard edit, 2.05 s Vitest / 4.65 s wrapper; independently reviewed.                                                                   | `m04-history-final-tests.log`                                                                 |
| Direct owner/adapter/Solid view regression                                     | Two actual focus/readonly integration regressions reproduced before the fix; all seven final integration cases PASS and are included in the combined batch.                          | `m04-direct-formatting-red.log`, `m04-direct-formatting-final.log`                            |
| Final pure formatter TypeScript check                                          | PASS for the four production core modules; it does not cover the UI integration graph.                                                                                               | `m04-core-final-types.log`                                                                    |
| Full UI TypeScript and changed integration graph                               | BLOCKED: checker processes killed with exit 137 under the available memory limit                                                                                                     | `m04-types.log`, `m04-types-go.log`, `m04-changed-types.log`                                  |
| Production UI build, including bounded-memory retry                            | BLOCKED: transformed 5,711 modules, then killed with exit 137 at chunk rendering                                                                                                     | `m04-ui-build-bounded.log`                                                                    |
| Scoped type-aware lint                                                         | PASS across 45 changed TypeScript/TSX files; five Solid reactivity warnings occur at unchanged baseline call sites. No baseline or suppression was raised.                           | `m04-final-lint-clean.log`                                                                    |
| Control UI controller guard, English catalog baseline/verification, review CSS | PASS; existing owner/effect/listener/import ratchets retained.                                                                                                                       | `m04-solid-final-guard.log`, `m04-i18n-final.log`, `m04-i18n-verify.log`, `m04-stylelint.log` |
| Changed documentation MDX                                                      | PASS for all three changed Markdown documents.                                                                                                                                       | `m04-docs-mdx-final.log`                                                                      |
| Full documentation links with anchors                                          | Eight failures; reproduced the identical eight at the checkout base, with zero new broken links across 20,259 checked links. The optional ClawHub mirror was unavailable.            | `m04-docs-links.log`, `m04-docs-links-baseline.log`                                           |
| Test-line and maximum-line ratchets                                            | PASS: +2,269 LF lines, default allowance 400 plus requested allocation 1,869; no raised suppression baseline.                                                                        | `m04-test-lines-final.log`, `m04-max-lines-final.log`                                         |
| Changed-file formatting                                                        | PASS for code, configuration, styles, and all three changed Markdown documents.                                                                                                      | `m04-final-format.log`, `m04-docs-format-final.log`                                           |
| Standalone benchmark audit                                                     | Production unused-file scan PASS with zero entries; full-tree scan BLOCKED by 1 GiB JavaScript heap exhaustion. The exact benchmark entry is modeled, with no broad ignore.          | `m04-deadcode-final.log`                                                                      |
| Benchmark audit configuration lint                                             | Direct syntax lint PASS. Canonical root type-aware lint BLOCKED during SDK boundary declaration preparation (exit 13); it did not reach lint.                                        | `m04-knip-config-syntax-lint.log`, `m04-knip-config-lint.log`                                 |
| Canonical browser proof source attempt                                         | BLOCKED in browser setup: one failed suite, all ten scenarios skipped. No product assertions or screenshots ran. Installing the pinned browser failed with HTTP 403.                 | `m04-source-e2e-attempt1.log`, `m04-playwright-install.log`                                   |

```text
All results above use this worktree's own physical dependency installation.
The frozen lockfile is unchanged. Install ownership validation passed.
```

Focused commands:

```bash
pnpm test ui/src/lib/dictation/formatting.node.test.ts --maxWorkers=1
pnpm test ui/src/app/settings-formatting.test.ts --maxWorkers=1
pnpm test ui/src/lib/composer-input.test.ts --maxWorkers=1
pnpm test ui/src/pages/chat/composer-dictation-formatting.test.ts --maxWorkers=1
pnpm test ui/src/pages/chat/components/composer-dictation-formatting.test.tsx --maxWorkers=1
pnpm test ui/src/pages/chat/composer-dictation.test.ts --maxWorkers=1
pnpm test ui/src/pages/chat/composer-dictation-review.test.ts --maxWorkers=1
pnpm test ui/src/pages/chat/composer-direct-dictation.test.tsx --maxWorkers=1
pnpm test ui/src/pages/chat/composer-direct-dictation-formatting.test.tsx --maxWorkers=1
pnpm test ui/src/pages/chat/chat-session-rail.test.ts --maxWorkers=1
pnpm test ui/src/pages/chat/chat-composer-actions.test.ts --maxWorkers=1
pnpm test ui/src/pages/new-session/draft-dictation-session.test.ts --maxWorkers=1
pnpm test ui/src/pages/new-session/composer.test.tsx --maxWorkers=1
pnpm tsgo:ui
pnpm tsgo:test:ui
pnpm check:changed
pnpm ui:build
pnpm docs:check-links:anchors
pnpm format:docs:check
```

The 13 test paths above were combined into the final focused command with one
worker. The companion evidence manifest records the remaining targeted commands,
exit statuses, durations, and artifacts. Type/lint/format/build failures attributable to this change must be
fixed. An unrelated baseline failure needs its own baseline evidence; an
installation failure is a proof blocker, not a product test failure.

The semantic suite must use an independent Markdown parser, not just compare
the serializer with its own output. Parse the entire resulting Markdown draft,
including the delivery boundary, when proving structural fidelity. HTML tests
must reject every node/attribute outside the declared profile and observe zero
resource requests in the real preview.

## Live target and microphone procedures

1. Record OS/app versions, build/head, target capability descriptor, starting
   selection and draft, speech provider/model, locale, and microphone source.
2. On the actual microphone, speak the shopping-list fixture. Record recognized
   text independently from the structure result. Stop must release capture while
   the finishing state remains visible, with no automatic Send.
3. In an eligible direct plain field, review and apply once. Confirm exact text,
   unchanged surrounding content, selection/caret, and one-step Undo. Repeat with
   a field that lacks safe multiline/history support and confirm review/copy.
4. In the declared Markdown composer, use an empty draft and a whole-draft
   selection. Parse/render the inserted source and verify item count/order and
   numbering. A partial selection inside a code fence or existing list must be
   refused for formatted Apply.
5. Change focus, selection, draft, account, mode, policy, capability revision, and
   connection while capturing, finalizing, and reviewing. Include A→B→A changes.
   Confirm the old generation cannot acquire a new insertion target.
6. Cancel before preparation, before Apply, and from inside an attempted edit.
   Inject a result with an uncertain effect. Confirm no retry, automatic plain
   insertion, form submission, attachment, or execution occurs.
7. For the required rich editor, identify a qualified M10 adapter and test actual
   list nodes, selection replacement, focus refusal, Undo, and unknown-effect
   recovery on named OS/editor versions. A semantic preview or fake adapter
   cannot satisfy this step.

**Observed external outcome:** NOT RUN. Real microphone/STT access and a qualified native
rich adapter/device have not been established by this ledger. Record each missing
resource and the concrete recovery procedure; keep the PR draft while required
proof is unavailable.

## Accessibility and visual procedures

Use the actual built Control UI with synthetic content. Complete record, Stop,
review, marker confirmation, format selection, Apply/Keep original, Copy,
Reprocess, and Escape using the keyboard. Verify visible focus and focus return.
With a named screen reader/browser combination, confirm actual paragraph/list
navigation and one stable status announcement per meaningful change.

Capture clean and annotated before/after screenshots in light/dark themes at
narrow and desktop widths. Repeat at 400% zoom and with enlarged text, high
contrast, and reduced motion. No review or recovery control may become hidden or
unreachable. Record actual browser/OS/screen-reader versions and artifacts.

**Observed outcome:** eight review-component tests and seven actual
owner/adapter/Solid view tests PASS. The canonical ten-scenario browser fixture
was attempted through its source-proof option because the production build was
blocked. Setup could not launch pinned Chromium revision 1248; the supported
installer received HTTP 403 from `cdn.playwright.dev`. All ten scenarios were
skipped. No screenshots, native Undo, browser keyboard, or resource-load evidence
were produced. The baseline screenshot attempt also ran out of disk during its
separate dependency installation; only that task-owned incomplete installation
was removed, preserving the base Git metadata.

The fixture includes narrow/high-contrast, RTL, enlarged-text, and a 200%-equivalent
CSS/DPR layout. These are not browser-chrome 400% zoom or screen-reader evidence.
Recovery requires the pinned browser download, a completed production build, and
the named hardware/assistive-technology procedure above. DOM assertions do not
certify those boundaries.

## Performance, privacy, and rollback procedures

Measure validation plus all renderings for 10,000 characters/100 blocks, escaped
worst cases, and depth-three nesting. Record named CPU/RAM/OS/runtime, source
length/UTF-8 size, cold and warm runs, sample count, p50/p95/p99, peak memory, and
failure/fallback counts. The proposed goal is p95 at most 50 ms. Keep
provider/STT time, private 2,500 ms finishing
deadline behavior, total Stop-to-preview time, and user review time separate.

Observe existing transcription requests and connection attempts through success,
failure, timeout, cancellation, and fallback. Confirm formatting adds zero
provider calls and never switches a selected route. Any local-only claim needs
evidence for the selected speech data plane; local formatting alone does not
prove local speech recognition or whole-device offline behavior.

Load a prior supported browser settings record and existing draft state, toggle
Explicit/Preserve, reload, use an unsupported policy version, and return to the
older client. Compare unrelated preferences and draft bytes. Confirm there is no
new transcript history, content log, clipboard manager, or history rewrite.
Diagnostic artifacts must contain synthetic content or only bounded phase/status,
reason, revision, count, and duration data.

### Measured local benchmark

`ui/src/lib/dictation/formatting.bench.ts` ran on the hardware recorded above.
Reproduce it with
`node --import ./scripts/tsx.mjs ui/src/lib/dictation/formatting.bench.ts`.
Each workload contains exactly 10,000 characters and 100 blocks; the nested
fixture has 99 items and depth 3. The escaping fixture uses ampersands for
fivefold HTML text expansion. There are 10 warmups and 100 measured warm samples
per workload. `m04-evidence/benchmark.json` records source hashes, measurements,
revision metadata and environment; publication must attach it to the final head.
After this measurement, `formatting.ts` had an identifier-only rename for the
repository's shadowing lint rule. The measured source hashes remain intact in
the benchmark artifact; the companion manifest records the final source hashes
and this delta. The other measured modules and benchmark harness are unchanged.

| Workload           | Validation + render p50 / p95 / max (ms) | Full preparation p95 (ms) | First call (ms) |
| ------------------ | ---------------------------------------- | ------------------------- | --------------- |
| Paragraphs         | 11.588 / 21.880 / 30.903                 | 59.576                    | 69.272          |
| Escaped paragraphs | 9.823 / 14.926 / 38.760                  | 36.211                    | 15.240          |
| Nested lists       | 18.170 / 34.074 / 95.481                 | 70.478                    | 35.917          |

All three validation-plus-rendering warm p95 values met the proposed 50 ms
budget. Full preparation includes parsing/planning and did not meet 50 ms on
all workloads. Only the first workload's first call was process-first; the
harness does not reset the JIT between workloads. These are not repeated cold
start distributions. Tail latency remains visible in the table. The harness
did not record p99; no p99 claim is made.

Peak **observed between iterations** was 199,987,200 bytes RSS and 72,333,120
bytes heap used across the process. This is not continuous peak-allocation
profiling. The harness makes zero provider requests. Provider/STT time, actual
microphone-to-preview time and user review time are **NOT RUN**; zero benchmark
network calls must not be reported as zero speech-provider latency.

Prior-record/unsupported-policy/rollback fixtures and unrelated preference/draft
retention passed the settings suite. A production install downgrade and actual
speech-route privacy/egress capture remain **NOT RUN**.

## Independent review and publication gates

An independent read-only source review identified source-gap concatenation,
protected whitespace loss, ordinary marker discussion, start/stop selection
mismatch, focus restoration races, incomplete-result reprocessing, and Markdown
context insertion as actionable risks. Those findings were fixed and
independently rechecked. Final review also covered the stateless owner extraction,
actual readonly/disabled capability facts, editable Explicit capture, main and
direct no-Send guards, owner-keyed Finish control cleanup, and captured focus
callbacks. It found no remaining actionable production findings. One obsolete
test trigger was corrected without changing its assertions; the affected 34-case
suite passed. Settings received review from a contributor other than their author.
The final settings and history-capability guard received an additional independent
review with no actionable findings. The four history-transaction cases passed
again after the final guard edit. The companion manifest records the reviewed
source hashes and commit binding.

Before publication, fill in the final head/base, actual checks and artifact URLs,
maintainer acceptance/dependency status, and all blocked criteria. Recheck the
current contributor PR limit and the author's open PR count including drafts.
Use the repository's required PR headings and do not close the umbrella issue or
mark the PR ready while mandatory behavior or evidence remains incomplete.
