# PR Handoff: Probe cooldown side-effects + fallback attribution

## Goal

Document and package a candidate fix for two related model-fallback behaviors:

1. Fallback error strings over-attribute provider/profile cooldown to each model.
2. `models status --probe` can mutate auth cooldown state and affect production runs.

This handoff is intended for deep review before opening an upstream PR.

## Branch / scope

- Branch: `bugfix/probe-cooldown-fallback-attribution`
- Repository: `projects/openclaw`
- Local unrelated edits intentionally left untouched:
  - `src/agents/models-config.normalizes-antigravity-api.test.ts`
  - `src/agents/models-config.providers.ts`

Only the files below are part of this bugfix candidate:

- `src/agents/model-fallback.ts`
- `src/agents/model-fallback.test.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts`
- `docs/debug/model-fallback-provider-cooldown-issue-draft.md`
- `docs/debug/handoff-probe-cooldown-fallback-pr.md`

## User-visible problem

Observed failure example (from local logs on `2026-02-13`):

- First model returned explicit 429 capacity error.
- Subsequent fallback entries looked like each model independently failed.
- In reality, later entries were primarily provider/profile cooldown skips.

Representative error:

`All models failed (6): ... google-antigravity/... No available auth profile ... | ... openai-codex/... Provider openai-codex is in cooldown ...`

## Root-cause analysis

### 1) Fallback attribution issue

- `runWithModelFallback` pre-skips candidates when all provider profiles are in cooldown:
  - `src/agents/model-fallback.ts` (cooldown pre-check in candidate loop)
- Final summary renders each attempt as `<provider>/<model>: <error>`, including skipped candidates.
- That makes provider-level unavailability look like model-level failures.

### 2) Probe side-effect issue

- `openclaw models status --probe` calls `runEmbeddedPiAgent` with `probe-*` session IDs:
  - `src/commands/models/list.probe.ts`
- In `runEmbeddedPiAgent`, probe sessions were identified but still passed through `markAuthProfileFailure` in key failure paths.
- Result: probe timeouts/rate-like failures could update cooldown state and impact later traffic.

## Proposed fix (implemented in this branch)

### A) Clarify fallback summaries for provider cooldown skips

Changes:

- Preserve `provider/model:` per-attempt formatting for compatibility.
- Mark provider-cooldown skips explicitly at model-entry level:
  - `provider/model: skipped (provider cooldown: all auth profiles in cooldown) (rate_limit)`

Files:

- `src/agents/model-fallback.ts`
- `src/agents/model-fallback.test.ts`

### B) Make probe sessions non-penalizing for auth cooldown

Changes:

- Add explicit probe flag (`isProbeRun`) and thread it from `models status --probe`.
- Guard cooldown writes with `!isProbeRun` where `markAuthProfileFailure` is called in embedded run failure paths.
- Remove cooldown-suppression heuristics based on `sessionId.startsWith("probe-")` in patched runner paths.

Files:

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts`

## Tests added / updated

1. `src/agents/model-fallback.test.ts`
   - Adds assertion that provider-cooldown skips are grouped in final summary text.
2. `src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts`
   - Adds probe-session timeout case and asserts no `cooldownUntil` / `lastFailureAt` is written.

## Verification run

Executed:

```bash
pnpm vitest run src/agents/model-fallback.test.ts src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts
pnpm exec oxfmt --check src/agents/model-fallback.ts src/agents/model-fallback.test.ts src/agents/pi-embedded-runner/run.ts src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts docs/debug/model-fallback-provider-cooldown-issue-draft.md docs/debug/handoff-probe-cooldown-fallback-pr.md
```

Status:

- Tests: pass
- Formatting: pass

## Risk / review points for deep agent

1. Product semantics:
   - Should probe always be non-penalizing, or should this be configurable?
2. Wording compatibility:
   - Existing downstream tooling may parse `All models failed (...)` message format.
3. Cooldown policy intent:
   - If probes are intended to reflect real availability pressure, skipping penalties may hide short-lived hot states.
4. Additional paths:
   - Confirm no other probe code paths still call cooldown mutators indirectly.

## Alternative considered

- Add an explicit `probeMode` / `suppressAuthPenalty` flag to `RunEmbeddedPiAgentParams` and thread it from probe command.
- Current patch uses `sessionId.startsWith("probe-")`, which is consistent with existing probe detection but less explicit than a first-class flag.

## Recommended next step

Deep-review this branch and decide between:

1. PR as-is (minimal invasive change, tests included).
2. Follow-up refinement: explicit runner flag instead of session-name convention.
