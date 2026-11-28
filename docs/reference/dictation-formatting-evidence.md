---
doc-schema-version: 1
summary: "M04 repair scope, reproduction procedures, and outstanding dictation formatting qualification"
read_when:
  - You are reviewing the dictation formatting implementation
  - You are collecting semantic, lifecycle, accessibility, or target evidence
title: "Dictation formatting evidence"
---

This ledger accompanies [issue #205634](https://github.com/openclaw/openclaw/issues/205634)
and [draft PR #205791](https://github.com/openclaw/openclaw/pull/205791).
The [user guide](/web/control-ui-dictation-formatting) describes the proposed
grammar and delivery boundaries. M04 and M11 are planning identifiers.

The [PR Evidence](https://github.com/openclaw/openclaw/pull/205791#evidence)
records results by tested revision, including hosted jobs and their links.
This ledger describes what those checks cover and what is still unqualified.

## Captured New Session journey

The real Gateway and local Vosk journey passed on published head
`6241a650991542e61549668334ed99e149f261c6`. It also passed on prepared tree
`227ff6f5f87541c40df696224a5610366d07eb54`, after integrating upstream
`b7b81558906bd47c7c774d1d082169fced9c3922` and repairing render-time storage access
and idle cancellation. The production UI ran in Chromium with a prerecorded
synthesized WAV as its fake microphone. Local Vosk transcribed the audio;
these were not canned transcript events from a mock Gateway.

The captured output records Stop, blocked Enter and disabled Start while the
final transcript was held, command confirmation and semantic review, Markdown
Apply, native Undo, and zero sends. This does not qualify a physical microphone,
a cloud speech provider, or an external rich editor.

## Revision and environment record

| Field                         | Recorded value                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Contribution                  | `CompleteDotTech/openclaw:feat/dictation-semantic-formatting`; existing draft PR #205791                              |
| Reviewed parent               | `75070f7628a8651907294c60ce33037e08be1c85`                                                                            |
| Historical feature merge base | `04b854b239cd8ab8a14beae4914ed9c54d791e62`                                                                            |
| Published evidence            | [PR Evidence](https://github.com/openclaw/openclaw/pull/205791#evidence), with results scoped to each tested revision |
| ClawSweeper feedback          | [Durable PR review](https://github.com/openclaw/openclaw/pull/205791#issuecomment-7184857255)                         |
| Execution environment         | Isolated Linux workspace, Chromium, and a local Vosk model; public hosted CI is CompleteDotTech's fork CI             |
| Maintainer decisions          | Private shared owner, preferences, grammar, formats, limits and required fork workflow approval remain open           |

Bind each later result to the actual tested head, base, tree, dependency versions,
command and exit status. A source commit does not approve a fork workflow, make a
draft ready, or supply product acceptance. Changed sources require fresh checks
of the affected boundaries.

## Acceptance ledger

The table describes the scope of qualification. See the PR for observed
outcomes. The original issue remains open, including native/rich delivery and
accessibility requirements that the bounded Control UI implementation does not
yet qualify.

| Criterion                                     | Source boundary and authored coverage                                                                                         | Remaining proof or decision                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| M04-AC01: policy and baseline                 | Existing browser settings and dictation owner; Preserve default, opt-in and unknown-version fixtures                          | Real stored-data upgrade and rollback; acceptance of the shared preference owner                                   |
| M04-AC02: lexical and structural invariants   | Source spans, paragraphs, lists, numbering, protected bytes and independent Markdown parsing                                  | Run semantic tests; qualify actual recognition and destination fidelity                                            |
| M04-AC03: literal markers and reviewed intent | Every unprotected lexical command requires exact confirmation; unselected words stay literal; quotes/code/URLs stay protected | Run core, owner and review UI cases; exercise the real checklist and source invalidation                           |
| M04-AC04: bounded validation                  | Source coverage, grapheme offsets, node/version/count/depth checks, complete fallback at more than 20 command candidates      | Run malformed-input and boundary tests; maintainer acceptance and corpus qualification of limits                   |
| M04-AC05: deterministic safe rendering        | One validated document; independent Markdown/HTML parser fixtures                                                             | Run parser checks and observe zero unintended browser resource loads; qualify the accepted rich format             |
| M04-AC06: capability-selected representation  | Chat, New Session and Side chat declare Markdown; escaped literals and whole-draft context guard                              | Built destination journeys and received/rendered message evidence; external rich adapter still unqualified         |
| M04-AC07: lifecycle and at-most-once recovery | Existing capture/final-drain owner, immutable source/target guards, cancellation and unknown-effect receipts                  | Run owner/session suites and real focus, edit, connection and late-event journeys                                  |
| M04-AC08: inert text delivery                 | Captured-range editor replacement, isolated history, recipient identity/access fixtures, preserved whole-draft proposals      | Actual selected-range and caret insertion, one Undo/Redo, recipient records, native fallback and no automatic Send |
| M04-AC09: accessible review                   | Native controls, status and focus paths; synthetic browser fixture uses one Finish action before review                       | Built keyboard and named screen-reader session, before/after visuals, 400% zoom, contrast and enlarged text        |
| M04-AC10: upgrade, privacy and resources      | Existing settings owner, transient review, bounded benchmark source                                                           | Latest-stable upgrade/required rollback, actual egress/provider observation and fresh timing/memory measurements   |

Headings, tables and inferred Suggest structure remain outside the proposed first
slice. Deferring universal native insertion does not silently complete the
original issue's broader acceptance criteria.

## Minimal neutral lifecycle prerequisite

Capture, final drain, ordered commits, insertion, recipient state and history stay
with their existing owners. There is no new public plugin/RPC/storage framework.
The proposed shared preparation/preference boundary with M01/M11 still needs a
maintainer decision; this repair does not rename the experimental
`dictationFormatting` field or implement a future shared schema.

Feature-level preparation does not replace transport authorization. Preserve
current-generation checks, credential-dispatch authority, provider-frame and
transcript-publication guards, and authorized Stop/final-transcript handling.
Retained transcript identity/finality, exact source ranges, target selection,
policy and capability facts remain separate from a successful delivery receipt.

Delivery distinguishes `not-committed`, `committed` and `outcome-unknown`.
Cancellation after an attempted indivisible effect cannot reset the receipt or
authorize an automatic retry.

## Focused automated procedures

These are procedures for an approved isolated execution checkout. First inspect
that checkout's scripts and run `pnpm changed:lanes --json`; then select the owning
test paths through the supported runner. Serialize checks or use the documented
separate module-cache ownership.

```bash
pnpm test ui/src/lib/dictation/formatting.node.test.ts --maxWorkers=1
pnpm test ui/src/lib/composer-input.test.ts --maxWorkers=1
pnpm test ui/src/pages/chat/composer-dictation-formatting.test.ts --maxWorkers=1
pnpm test ui/src/pages/chat/composer-dictation-review.test.ts --maxWorkers=1
pnpm test ui/src/pages/chat/composer-direct-dictation-formatting.test.tsx --maxWorkers=1
pnpm test ui/src/pages/chat/components/composer-dictation-formatting.test.tsx --maxWorkers=1
pnpm test ui/src/pages/chat/composer-direct-dictation.test.tsx --maxWorkers=1
pnpm test ui/src/pages/new-session/composer.test.tsx --maxWorkers=1
pnpm test ui/src/pages/new-session/draft-dictation-session.test.ts --maxWorkers=1
pnpm test ui/src/app/settings-formatting.test.ts --maxWorkers=1
pnpm tsgo:ui
pnpm tsgo:test:ui
pnpm ui:i18n:baseline
pnpm ui:i18n:verify
pnpm check:changed
pnpm ui:build
pnpm docs:check-links:anchors
pnpm format:docs:check
```

The English confirmation/overflow copy changed. Run the canonical keyless i18n
baseline generator in that allowed environment and commit any generated raw-copy
baseline delta before considering that check complete; do not hand-edit
generated baselines. See the PR for the exact checks that ran.

The semantic tests author expected source ranges independently of the formatter,
parse Markdown with an independent parser, and inspect an allowlisted HTML tree.
The editor regressions instantiate the real editor path in their test harness.
A fake history bridge or a passing DOM test would not by itself qualify native
browser Undo or assistive technology.

Use the checkout's documented browser route for
`ui/src/e2e/dictation-formatting.e2e.test.ts`. It uses the shared production bundle
with synthetic media, STT, and Gateway fixtures and cannot replace the real
journey above. The fixture's main and New Session flows emit text before a single
keyboard Finish; list commands are explicitly checked before formatted Apply.

## Live target and microphone procedures

1. Record the candidate head/tree, served `dist/control-ui` asset hash, OS/browser,
   actual Gateway and provider/model, locale, physical microphone, destination
   capability and starting draft/selection. Build the assets actually served.
2. Speak a controlled fictional shopping list. Record recognition independently
   from formatting. Finish must release capture, retain finalization feedback
   and avoid automatic Send. Confirm the intended command occurrences in review.
3. In Chat, start with distinct recipient IDs sharing a display name, mentions
   before and after the selected range, and each supported access value. Use
   **Keep original** for a partial replacement and for caret insertion. Inspect
   actual recipient records, offsets and access metadata. One Undo must restore
   the prior text and records; one Redo must restore the accepted state. Include
   insertion adjacent to a mention that invalidates its boundary.
4. In Chat, New Session and Side chat, apply confirmed structure to an empty
   draft and a whole-draft selection. Independently parse/render the entire
   result, including literal asterisks/underscores and repeated/skipped numbers.
   A partial selection inside a code fence or existing list must refuse formatted
   Apply while eligible original/copy recovery remains available.
5. Exercise an intentional whole-draft proposal and its receipt Undo. Then edit
   the accepted text and confirm that the old receipt cannot undo newer work.
6. Change focus, selection, draft, account, policy, capability and connection
   during capture, finalization and review, including change-and-restore cases.
   Cancel at each boundary. An uncertain edit result must prevent retry and must
   not submit, attach, execute, or insert automatically elsewhere.
7. Qualify each native/plain/rich adapter separately on named OS/editor versions.
   Require actual selection replacement, recipient metadata where relevant,
   focus refusal, one Undo and unknown-effect recovery. The semantic preview
   does not establish external insertion support.

The captured real Gateway/local Vosk journey above covers New Session with a
prerecorded WAV. A physical microphone, cloud-provider behavior, and external
native/rich insertion remain unqualified.

## Accessibility and visual procedures

Use the actual built UI with controlled fictional content. Complete record,
Finish, marker confirmation, format selection, Apply/Keep original, Copy,
Reprocess, Dismiss and Escape by keyboard. Inspect visible focus and focus
return. With a named screen-reader/browser pair, verify paragraph/list navigation
and a stable status announcement for each meaningful change.

Capture real before/after views in light/dark themes at narrow and desktop
widths, 400% browser zoom, enlarged text, high contrast and reduced motion.
Review and recovery controls must stay reachable. Redact sensitive content before
saving any capture. No adjacent capture/recovery screenshot is evidence of this
formatting behavior.

The bundled synthetic browser fixture covers narrow, RTL, high-contrast,
enlarged-text and 200%-equivalent geometry. The PR links captured visuals. These
do not establish 400% browser-chrome zoom or screen-reader behavior.

## Performance, privacy, and rollback procedures

Resolve the actual latest stable release when executing compatibility proof.
In a new isolated installation, create and exercise valid stable settings,
drafts and recipient metadata, then upgrade to the exact candidate and compare
the stored data and behavior. Check Preserve/default-off behavior, Explicit
opt-in, unrelated preferences, unsupported versions and the required rollback
scope. Distinguish a released schema from the experimental branch field and the
unaccepted shared-policy proposal. Normalization fixtures and release metadata
alone are not an upgrade result.

Observe provider requests and connection attempts through success, failure,
timeout, cancellation and fallback. Deterministic formatting source adds no
provider invocation, but that does not prove offline speech recognition or
whole-device privacy. Record the actual selected route and egress. Do not add
transcript history or content-bearing diagnostics. Use synthetic content or
bounded status/count/timing data in artifacts; redact before saving.

**Upgrade, rollback and actual privacy/egress outcome: NOT COLLECTED.** No stable
version, successful migration or hardware observation is invented in this ledger.

### Measured local benchmark

No measurement exists for this repair. The heading is retained for existing
links; historical numbers are not carried forward as current results.

The revised `ui/src/lib/dictation/formatting.bench.ts` authors exactly
10,000 UTF-16-character workloads within the 20-command confirmation cap:

| Workload           | Commands | Blocks | Maximum list depth | Measurement status |
| ------------------ | -------- | ------ | ------------------ | ------------------ |
| Paragraphs         | 20       | 21     | 0                  | NOT RUN            |
| Escaped paragraphs | 20       | 21     | 0                  | NOT RUN            |
| Nested lists       | 18       | 7      | 3                  | NOT RUN            |

The harness specifies 10 warmups and 100 measured samples per workload, separates
preparation from validation plus all renderings, and rejects fallback timings.
It records source hashes, head, hardware/runtime, first call, p50/p95/max and
between-iteration memory observations. The proposed validation/rendering target
is p95 at most 50 ms. No first-call distribution, p99 or continuous memory peak
is implied. Provider time, the separate 2,500 ms local preparation budget, total
microphone-to-preview latency and user review time require separate measurements.

After execution is authorized, reproduce the harness through the checkout's
documented command:

```bash
node --import ./scripts/tsx.mjs ui/src/lib/dictation/formatting.bench.ts
```

## Independent review and publication gates

The [ClawSweeper review](https://github.com/openclaw/openclaw/pull/205791#issuecomment-7184857255)
applies to the reviewed parent, not automatically to this follow-up. Source
inspection by a separate reviewer is also distinct from executing ClawSweeper
or obtaining maintainer acceptance.

The repair keeps the original whole-draft contract from
[PR #201695](https://github.com/openclaw/openclaw/pull/201695), merged as
[`a3d7e40f2957d8efe05d87491e82177c5a01fe9f`](https://github.com/openclaw/openclaw/commit/a3d7e40f2957d8efe05d87491e82177c5a01fe9f).
Pinned source inspection traces proposal acceptance through `replaceDraft` to
`editor.replaceAll`, one isolated whole-document history transaction, and receipt
Undo through `editor.undo()`. A later differing draft retires that receipt.
Captured-range dictation now uses `editor.replace` with the existing isolated
history option; it does not replace the whole-proposal owner.

Before readiness or merge, complete current-head checks and generated baseline
work, built-product behavior, recipient/history and all destination qualification,
real stored-data compatibility, and the required maintainer decisions. Fork
workflow approval remains maintainer-owned. A commit alone does not resolve any
uncollected proof, request a new review, close the issue or mark the PR ready.
