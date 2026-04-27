---
summary: "Maintainer handoff for the RuntimePlan finalization 7-PR roadmap (RFC 72072)"
read_when:
  - Reviewing the merged RFC 72072 series
  - Picking up deferred follow-up work after the 7-PR series lands
  - Smoke-testing GPT-5.4 paths after the structural cleanup ships
title: "RuntimePlan finalization complete"
---

## Status

Originally drafted as PR 7 (docs-only) for [RFC 72072](https://github.com/openclaw/openclaw/issues/72072). Companion to the baseline doc at [`docs/refactor/runtime-plan-finalization-baseline.md`](./runtime-plan-finalization-baseline.md). Captures the final state of the 7-PR roadmap, the deferred follow-up work, and the verification commands a maintainer should run after the structural PRs land. It was later carried into the consolidated cleanup package with the code/test PRs it summarizes.

## Series at a glance

> **Update:** PR [#72276](https://github.com/openclaw/openclaw/pull/72276) supersedes the seven-PR plan and lands the consolidated cleanup package together with the structural-split follow-ups (`attempt-prompt.ts`, `attempt-transport.ts`, `attempt-lifecycle.ts`, `attempt-stream-wrappers.ts`, `runtime-plan-factory.ts`, `lane-workspace.ts`, `terminal-result.ts`). The per-PR rows below are preserved for traceability and review-by-slice; see the [#72276 description](https://github.com/openclaw/openclaw/pull/72276) for the consolidated commit stack map.

The original seven PRs were opened as drafts on fresh `origin/main` branches; none stacked at first. Each linked the RFC plus the relevant predecessor and follow-up PRs.

| #   | Title                                      | PR                                                        | Effect                                                                                                                                                                                                                       |
| --- | ------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Document RuntimePlan finalization baseline | [#72098](https://github.com/openclaw/openclaw/pull/72098) | Doc only. Captured drift between RFC recon and `origin/main` at HEAD `64af2feda0`. Adjusted later-PR scope.                                                                                                                  |
| 2   | Add native AgentHarnessV2 factory registry | [#72105](https://github.com/openclaw/openclaw/pull/72105) | Native V2 factory registry + parity test. Built-in PI registers a native V2; selection prefers it, falls back to V1 adapter. Public `AgentHarness` surface unchanged.                                                        |
| 3   | Extract attempt tool-policy helpers        | [#72110](https://github.com/openclaw/openclaw/pull/72110) | Reduced scope. Extracted `resolveUnknownToolGuardThreshold`, `applyEmbeddedAttemptToolsAllow`, `shouldCreateBundleMcpRuntimeForAttempt`, `collectAttemptExplicitToolAllowlistSources` from `attempt.ts` (3,212 → 3,091 LOC). |
| 4   | Extract attempt message summary helpers    | [#72113](https://github.com/openclaw/openclaw/pull/72113) | Reduced scope. Extracted `summarizeMessagePayload`, `summarizeSessionContext` from `attempt.ts`.                                                                                                                             |
| 5   | Extract run orchestration helpers          | [#72116](https://github.com/openclaw/openclaw/pull/72116) | Reduced scope. Extracted `createEmptyAuthProfileStore`, `buildTraceToolSummary`, `backfillSessionKey`, `buildHandledReplyPayloads` from `run.ts` (2,347 → 2,259 LOC).                                                        |
| 6   | Add embedded runner directory barrels      | [#72118](https://github.com/openclaw/openclaw/pull/72118) | Reduced scope. Created `embedded-runner/index.ts` (canonical) and `pi-embedded-runner/index.ts` (deprecated). Extended `aliases.test.ts` with directory-barrel identity asserts.                                             |
| 7   | This handoff doc                           | [#72119](https://github.com/openclaw/openclaw/pull/72119) | Originally drafted as doc-only; carried into the consolidated cleanup package with the six predecessor slices.                                                                                                               |

## Why several PRs landed at reduced scope

Recon for the RFC happened against an earlier `origin/main` snapshot than the one this series anchors on. Between those two points, 442 commits landed. Several load-bearing files moved or were already partially refactored by the time PR 1 baseline ran:

- `attempt.ts` grew from ~2,850 LOC to 3,212 LOC, with much of the file already decomposed into dot-prefixed leaf helpers (`attempt.transcript-policy.ts`, `attempt.subscription-cleanup.ts`, etc.).
- `run.ts` grew from ~2,100 LOC to 2,347 LOC.
- `pi-embedded-runner.ts` shrank from ~504 LOC to 49 LOC and had already been turned into a thin alias barrel using `as`-aliasing for neutral names.
- `embedded-runner.ts` (canonical flat barrel) already existed as a 17-LOC neutral re-export of `pi-embedded-runner.ts`.
- `aliases.test.ts` already included the bidirectional neutral-vs-Pi identity asserts the RFC asked PR 6 to add.

After deeper analysis, two structural assumptions in the RFC's PR 3-5 scope no longer held:

1. **Prompt-cache prep is per-turn, not per-attempt.** `beginPromptCacheObservation` is called inside the per-turn stream loop in `runEmbeddedAttempt`, not once during attempt setup. Pulling it out into a one-shot `prepareAttemptPromptCache` function the way PR 3 imagined is not safe without first doing PR 4's stream-loop split.
2. **Stream loop and lifecycle share one closure.** The cleanup `finally` block alone references 15+ pieces of closure state (`session`, `sessionManager`, `releaseWsSession`, `bundleMcpRuntime`, `bundleLspRuntime`, `sessionLock`, `removeToolResultContextGuard`, `flushPendingToolResultsAfterIdle`, `aborted`, `timedOut`, `idleTimedOut`, `timedOutDuringCompaction`, `promptError`, `params.sessionId`, `emitDiagnosticRunCompleted`, `trajectoryRecorder`, `trajectoryEndRecorded`). Splitting into `attempt-stream-loop.ts` + `attempt-lifecycle.ts` cleanly needs explicit data-flow contracts and full e2e regression coverage on cleanup ordering, abort handling, compaction, and prompt-cache observation parity.

PR 3-5 each delivered a smaller, safer ownership-boundary slice (pure helper extraction) and explicitly deferred the larger structural splits. PR 6 dropped the items already on `main` and shipped only the missing directory barrels.

## Deferred follow-up work

Not blocking RFC 72072 closure. Each is its own focused future PR.

### Structural splits

#### Landed in the consolidated PR (#72276)

The PR 3-5 RFC scopes that originally did not fit single review-able slices have now shipped in the consolidated package:

- **`attempt-prompt.ts`** — bootstrap routing/context injection and prompt-boundary preparation helper extracted from `attempt.ts`.
- **`attempt-transport.ts`** — per-turn `streamFn`, transport override, text-transform, extra-param, and prompt-cache-retention helper.
- **`attempt-lifecycle.ts`** — diagnostic `run.started` / once-only `run.completed` lifecycle emitter.
- **`attempt-stream-wrappers.ts`** — ordered stream wrapper stack for cache tracing, transcript sanitation, yield abort, malformed tool-call cleanup/repair, payload logging, and stop-reason recovery.
- **`runtime-plan-factory.ts`** — attempt input builder and RuntimePlan wiring extracted from `run.ts`.
- **`lane-workspace.ts`** — queue lane planning, tool-result format selection, probe-session detection, abort normalization, workspace context resolution, and fallback logging.
- **`terminal-result.ts`** — success terminal `EmbeddedPiRunResult` shaping, stop-reason priority, execution trace, request shaping, completion trace, pending hosted tool calls, and silent-empty payloads.

#### Still deferred

- **`attempt-stream-loop.ts`** — the per-turn send/yield/tool execution loop. Needs explicit data-flow contracts for the closure state captured in the cleanup `finally` block plus a focused abort-during-stream test before extraction is safe.
- **`model-auth-plan.ts`** (~150-270 LOC) — the remaining piece of the RFC's run-orchestration four-module split. Its seams sit inside `runEmbeddedPiAgent`'s closure with deep state dependencies and warrant a separate focused pass.

### Plugin-side work intentionally out of scope

- **Native AgentHarnessV2 plugin SDK widening.** The RFC explicitly listed this as optional future. Extensions like Codex still register V1 harnesses via `registerAgentHarness(...)` and are V1-adapted at call time. When the plugin SDK widens, extensions can register their own native V2 factories through the existing internal registry seam (#72105) once it is exposed via `openclaw/plugin-sdk/agent-harness-runtime`.
- **WS pooling default-on.** Out of scope per the RFC.

### Naming-canonicalization follow-ups (PR 6 deferrals)

- **`@deprecated` JSDoc on Pi-named exports.** Adding tags on every Pi-named symbol can produce noisy CI lint warnings if expected internal callers still use those names. Worth landing once the directory barrels (#72118) are merged and a survey of internal call sites is complete.
- **ESLint `no-restricted-imports` warn rule** against `**/pi-embedded-runner` outside compat barrels and tests. Wire through the existing `lint:core` pipeline rather than a fresh script. Compat barrels (`pi-embedded-runner.ts`, the new `pi-embedded-runner/index.ts`) and the many `pi-embedded-runner/run/*` test files need explicit exemptions.
- **`RunEmbeddedAgentFn` canonical type vs `RunEmbeddedPiAgentFn` alias** in `src/plugins/runtime/types-core.ts`.
- **Doc additions for Pi-vs-Codex ownership** in `docs/pi.md`, `docs/concepts/agent-loop.md`, `docs/concepts/agent-runtimes.md`, `docs/plugins/sdk-runtime.md`. PR 1's recon noted these are already accurate; a fresh content audit before edits avoids redundant churn.

## End-to-end verification (run after merging the series)

| Check                              | Command                                                                                                                                                                                                                                                                                                                                                                                                  | Expected                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Architecture                       | `pnpm check:architecture`                                                                                                                                                                                                                                                                                                                                                                                | green: 0 runtime value cycles, 0 madge cycles                             |
| Type-check                         | `pnpm check:test-types`                                                                                                                                                                                                                                                                                                                                                                                  | green (or document any baseline drift; gate on targeted suites if needed) |
| RuntimePlan + Harness V2 contracts | `node scripts/run-vitest.mjs run --config test/vitest/vitest.agents.config.ts src/agents/runtime-plan/build.test.ts src/agents/runtime-plan/types.test.ts src/agents/runtime-plan/types.compat.test.ts src/agents/runtime-plan/tools.test.ts src/agents/runtime-plan/tools.diagnostics.test.ts src/agents/harness/v2.test.ts src/agents/harness/selection.test.ts src/agents/harness/builtin-pi.test.ts` | green                                                                     |
| Attempt orchestration + helpers    | `node scripts/run-vitest.mjs run --config test/vitest/vitest.agents.config.ts src/agents/pi-embedded-runner/run/attempt.test.ts`                                                                                                                                                                                                                                                                         | green                                                                     |
| Codex app-server                   | `node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts extensions/codex/src/app-server/run-attempt.test.ts extensions/codex/src/app-server/event-projector.test.ts extensions/codex/index.test.ts`                                                                                                                                                                            | green                                                                     |
| Embedded-runner aliases            | `pnpm test src/agents/pi-embedded-runner/aliases.test.ts`                                                                                                                                                                                                                                                                                                                                                | green: identity asserts pass through both flat and directory barrels      |

## GPT-5.4 smoke matrix

The RFC asks for end-to-end smoke across all four routes after the series merges:

| Route                    | What to verify                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai/*` GPT-5.4       | Tools, auth profile routing, prompt overlays, transcript repair, delivery, fallback classification, schema normalization, transport extra-params, `resolvedRef` observability. |
| `openai-codex/*` GPT-5.4 | Same checklist. Codex extension still registers V1 harness via `registerAgentHarness`; selection should adapt to V2.                                                           |
| `codex/*` GPT-5.4        | Same checklist.                                                                                                                                                                |
| `codex-cli/*` GPT-5.4    | Same checklist.                                                                                                                                                                |

This handoff doc cannot run the smoke matrix from CI — it depends on live model auth and operator-side environment. The expectation is that maintainers run it after the series merges and capture transcripts in the relevant project tracker. The cleanup PRs avoid live smoke in CI, but the Harness V2 resolution change still warrants operator verification before treating the finalization series as complete.

## Acceptance criteria assessment (RFC verbatim)

| Acceptance criterion                                                                 | Status after series                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RuntimePlan contracts remain green.                                                  | ✅ Covered by the targeted vitest set above. No RuntimePlan code changed.                                                                                                                                                                                                                                                                                                                                                                                  |
| Harness V2 is the internal lifecycle boundary for selected harness execution.        | ✅ #72105 added the native V2 factory registry; `selection.ts` now resolves V2 via `resolveAgentHarnessV2(harness)`, preferring native then falling back to adapter.                                                                                                                                                                                                                                                                                       |
| `attempt.ts` and `run.ts` are split by ownership boundary, not cosmetic convenience. | ✅ Landed in #72276. From `attempt.ts`: `attempt-prompt.ts`, `attempt-transport.ts`, `attempt-lifecycle.ts`, `attempt-stream-wrappers.ts`, `attempt-tools.ts`, `attempt-message-summary.ts`. From `run.ts`: `runtime-plan-factory.ts`, `lane-workspace.ts`, `terminal-result.ts`, `run-orchestration-helpers.ts`. Still deferred: `attempt-stream-loop.ts` and `model-auth-plan.ts` (data-flow contracts and abort-during-stream coverage required first). |
| Neutral embedded-runner naming is canonical; Pi names remain compatibility aliases.  | ✅ Pre-existed for the flat barrels; #72118 closed the directory-barrel gap.                                                                                                                                                                                                                                                                                                                                                                               |
| Docs accurately explain Pi vs Codex ownership.                                       | 🟨 Partial. PR 1's recon found existing docs were accurate at baseline time. Targeted doc additions are deferred to the follow-up audit.                                                                                                                                                                                                                                                                                                                   |
| GPT-5.4 smoke passes across OpenAI, OpenAI-Codex, Codex, and Codex CLI routes.       | ⏸️ Run by maintainers after merge per the matrix above.                                                                                                                                                                                                                                                                                                                                                                                                    |

## Notes for reviewers

- Linked RFC: [openclaw/openclaw#72072](https://github.com/openclaw/openclaw/issues/72072).
- Predecessor context: PR [#71722](https://github.com/openclaw/openclaw/pull/71722) (closed-merged at commit `2c35a6e`), RFC #71004 (closed-implemented).
- Companion baseline doc: [`docs/refactor/runtime-plan-finalization-baseline.md`](./runtime-plan-finalization-baseline.md) (added in #72098).
- In the original seven-PR draft series this file was documentation-only; in the consolidated package it ships alongside the production/test cleanup slices listed above.
- If maintainers want a different sequencing for the deferred structural splits, please flag here and I will queue follow-up PRs against this handoff doc rather than against the RFC issue directly.
