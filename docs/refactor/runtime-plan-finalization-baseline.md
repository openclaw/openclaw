---
summary: "Baseline health snapshot for the RuntimePlan finalization 7-PR roadmap (RFC 72072)"
read_when:
  - Picking up RFC 72072 (RuntimePlan finalization) follow-up PRs
  - Splitting `pi-embedded-runner/run/attempt.ts` or `run.ts`
  - Promoting Harness V2 from V1 adapter to native lifecycle boundary
title: "RuntimePlan finalization baseline"
---

## Status

Originally drafted as PR 1 (docs-only) in the 7-PR [RFC 72072](https://github.com/openclaw/openclaw/issues/72072) series. Its job is to capture a clean baseline before the structural PRs land, and to record the drift we found between the RFC's recon snapshot and current `origin/main`. It was later carried into the consolidated cleanup package with the code/test PRs it references.

The roadmap is:

1. **Originally drafted as PR 1** baseline doc and check capture
2. **PR 2** native internal Harness V2 factory and parity test
3. **PR 3** split Pi attempt preparation domains out of `attempt.ts`
4. **PR 4** split Pi stream loop and lifecycle out of `attempt.ts`
5. **PR 5** split embedded run orchestration out of `run.ts`
6. **PR 6** canonical neutral embedded runner naming finishing touches (reduced scope, see below)
7. **PR 7** final verification and maintainer handoff doc

Predecessor context: PR 71722 merged the consolidated package (commit 2c35a6e). RFC 71004 is closed as implemented. Superseded prototype PRs (71196 / 71197 / 71201 / 71220 / 71222 / 71223 / 71224 / 71238 / 71239) stay closed and are preserved in 71722 via cherry-pick -x.

## Baseline check capture

All commands ran on a clean clone of `origin/main` at HEAD `64af2feda0`, with `pnpm install` clean and `pnpm-lock.yaml` restored.

| Check                                                               | Outcome | Notes                                                                                                                                        |
| ------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:architecture`                                           | green   | 0 runtime value cycles, 0 madge cycles                                                                                                       |
| `pnpm check:test-types` (`tsgo:core:test` + `tsgo:extensions:test`) | green   | 0 type errors                                                                                                                                |
| Agents-config targeted vitest                                       | green   | 7 files exercised (45 tests across the 6 files vitest collected in the parallel run; running `types.test.ts` alone confirms its 2 tests run) |
| Extensions-config targeted vitest                                   | green   | 2 files (`run-attempt.test.ts`, `event-projector.test.ts`)                                                                                   |

Targeted vitest commands (matching the RFC's validation set):

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents.config.ts \
  src/agents/runtime-plan/build.test.ts \
  src/agents/runtime-plan/types.test.ts \
  src/agents/runtime-plan/types.compat.test.ts \
  src/agents/runtime-plan/tools.test.ts \
  src/agents/runtime-plan/tools.diagnostics.test.ts \
  src/agents/harness/v2.test.ts \
  src/agents/harness/selection.test.ts

node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts \
  extensions/codex/src/app-server/run-attempt.test.ts \
  extensions/codex/src/app-server/event-projector.test.ts
```

No baseline drift blocks any later PR. The RuntimePlan + Harness V2 + Codex app-server contracts are green.

## Drift between RFC recon and current main

The RFC's recon was a read-only WebFetch sweep against an earlier `origin/main` snapshot. Between that snapshot and the current `origin/main` at HEAD `64af2feda0` there are 442 commits, several of which touched the load-bearing files for this RFC. The table below records the deltas we measured at PR 1 time so PR 2 through PR 7 can re-recon from a known anchor.

| Recon claim (RFC)                                                | At recon time                        | At PR 1 time                                                                                                                 | Effect on later PRs                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-embedded-runner/run/attempt.ts` size                         | ~2,850 LOC                           | 3,212 LOC                                                                                                                    | PR 3 + PR 4 still apply. All seam line numbers in the RFC are starting points only. PR 3 / PR 4 must `wc -l` and `rg` to relocate exact seams before extracting. |
| `pi-embedded-runner/run.ts` size                                 | ~2,100 LOC                           | 2,347 LOC                                                                                                                    | PR 5 still applies. Re-recon seams.                                                                                                                              |
| `pi-embedded-runner.ts` (flat barrel)                            | ~504 LOC                             | 49 LOC, already a thin alias barrel using `as` neutral aliasing                                                              | PR 6 scope reduces (see below).                                                                                                                                  |
| `embedded-runner.ts` (canonical flat barrel)                     | did not exist                        | 17 LOC, exists as a neutral re-export of `pi-embedded-runner.ts`                                                             | PR 6 scope reduces.                                                                                                                                              |
| `pi-embedded-runner/aliases.test.ts` neutral asserts             | RFC said extend with neutral asserts | already present (line 15: `expect(runEmbeddedAgentFromNeutralBarrel).toBe(runEmbeddedPiAgent)`)                              | PR 6 scope reduces.                                                                                                                                              |
| `embedded-runner/index.ts` (canonical directory barrel)          | did not exist                        | still does not exist                                                                                                         | PR 6 still has scope here.                                                                                                                                       |
| `pi-embedded-runner/index.ts` (deprecated directory barrel)      | did not exist                        | still does not exist                                                                                                         | PR 6 still has scope here.                                                                                                                                       |
| Native V2 factory pattern                                        | did not exist                        | still does not exist; `harness/v2.ts` (255 LOC) only exports `adaptAgentHarnessToV2` and `runAgentHarnessV2LifecycleAttempt` | PR 2 scope unchanged.                                                                                                                                            |
| Test asserting native V2 result shape == adapted V1 result shape | did not exist                        | still does not exist                                                                                                         | PR 2 must add this parity test.                                                                                                                                  |
| `check:architecture` script                                      | exists, chains import-cycles + madge | unchanged                                                                                                                    | OK.                                                                                                                                                              |

The RFC-cited helper files that PR 3 + PR 4 must reuse (not move) all still exist at the same paths:

- `src/agents/pi-embedded-runner/run/attempt.transcript-policy.ts`
- `src/agents/pi-embedded-runner/run/attempt.subscription-cleanup.ts`
- `src/agents/pi-embedded-runner/run/attempt.sessions-yield.ts`
- `src/agents/pi-embedded-runner/run/attempt.stop-reason-recovery.ts`
- `src/agents/pi-embedded-runner/run/attempt.tool-call-argument-repair.ts`
- `src/agents/pi-embedded-runner/run/attempt.tool-call-normalization.ts`

In addition, current `origin/main` has more decomposed helpers under `pi-embedded-runner/run/` than the RFC anticipated, including:

- `attempt.context-engine-helpers.ts`
- `attempt.model-diagnostic-events.ts`
- `attempt.prompt-helpers.ts`
- `attempt.spawn-workspace.*.ts` (multiple test-support and test files)
- `attempt.thread-helpers.ts`
- `attempt.tool-run-context.ts`

These look like leaf-level helpers, not domain-level orchestrators. The PR 3 plan to add `attempt-tools.ts`, `attempt-prompt.ts`, and `attempt-transport.ts` as hyphen-prefixed domain orchestrators is therefore additive to the existing dot-prefixed leaf decomposition; it does not replace it. PR 3 should call into the existing leaf helpers, not move them.

## Adjusted plan per PR

### PR 2 unchanged

Add a `NativeAgentHarnessV2Factory` registry alongside the V1-adapter path in `harness/v2.ts`. Provide native factories for built-in Pi (in `harness/builtin-pi.ts`, currently 11 LOC) and for bundled Codex (`extensions/codex/harness.ts`). Update `harness/selection.ts` (399 LOC, V1-adapt at line 193) to prefer native, fall back to adapted V1. Add the parity-shape test that today does not exist.

`harness/index.ts` (27 LOC, public surface) stays untouched.

### PR 3 unchanged in shape, must re-recon seams

`attempt.ts` is 3,212 LOC (recon said 2,850). The RFC's seam line ranges are stale by hundreds of lines. PR 3's first commit must `wc -l` and `rg` to relocate exact seams for `attempt-tools.ts`, `attempt-prompt.ts`, and `attempt-transport.ts`. The cache-observation threading decision (return a `PromptCachePrep` struct from `prepareAttemptPromptCache`, accept it in `configureAttemptTransport`) still holds.

Existing helpers under `pi-embedded-runner/run/` are reused, not moved, by PR 3.

### PR 4 unchanged in shape, must re-recon seams

Same drift pattern as PR 3. Stream loop and lifecycle seams must be relocated. Tool-recovery helpers stay where they are. `cleanupEmbeddedAttemptResources` stays in `attempt.subscription-cleanup.ts` and is called from `attempt-lifecycle.ts`.

### PR 5 unchanged in shape, must re-recon seams

`run.ts` is 2,347 LOC (recon said 2,100). Main `runEmbeddedPiAgent` is at line 239. PR 5's first commit must relocate seams for `model-auth-plan.ts`, `runtime-plan-factory.ts`, `lane-workspace.ts`, and `terminal-result.ts`.

### PR 6 reduced scope

Maintainers shipped most of the canonicalization independently between the RFC's recon snapshot and PR 1 time. Specifically:

- `embedded-runner.ts` already exists as the canonical flat barrel.
- `pi-embedded-runner.ts` already aliases Pi names to neutral names with `as`.
- `aliases.test.ts` already includes neutral-barrel identity asserts.

What PR 6 still has to do:

- Add `embedded-runner/index.ts` as a canonical directory barrel that re-exports from `embedded-runner.ts`.
- Add `pi-embedded-runner/index.ts` as a deprecated directory barrel that re-exports from `embedded-runner/index.ts`.
- Mark Pi-named exports `@deprecated` via JSDoc with neutral-name pointers.
- Promote `RunEmbeddedAgentFn` to canonical and keep `RunEmbeddedPiAgentFn` as alias in `src/plugins/runtime/types-core.ts`.
- Add an ESLint `no-restricted-imports` warn rule against `**/pi-embedded-runner` outside compat barrels and tests, wired through the existing lint pipeline rather than a new script.
- Minimal docs additions for Pi vs Codex ownership in `docs/pi.md`, `docs/concepts/agent-loop.md`, `docs/concepts/agent-runtimes.md`, `docs/plugins/sdk-runtime.md` (only if the existing text is not already accurate; a fresh read at PR 6 time will confirm).

### PR 7 unchanged

Smoke `openai/*`, `openai-codex/*`, `codex/*`, and `codex-cli/*` GPT-5.4 paths. Capture transcripts. Add the maintainer handoff doc linking PR 1 through PR 6.

## What the original baseline PR (#72098) did not change

The doc-only baseline PR #72098 did not touch:

- Production code.
- Test code.
- The public plugin surface.
- Imports.
- File moves or renames.

(This file is now landing inside the consolidated PR #72276, which does include
production-code, test, and import changes — captured in the commit-stack table
in the PR description and the companion handoff doc.)

## Notes for reviewers

- Linked RFC: [openclaw/openclaw#72072](https://github.com/openclaw/openclaw/issues/72072).
- The RFC's recon was done against an earlier snapshot of `origin/main`. The drift table above is the audit. Subsequent PRs anchor on this baseline, not on the RFC's recon, when their seam line numbers conflict.
- PR 6 deliberately drops scope already on `main` rather than re-doing it. Please flag if any of the reduced items should be reintroduced as a stricter behavior.
