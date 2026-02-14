# Draft Issue: Fallback error attribution and probe side-effects

## Title

Fallback chain reports per-model failures when root cause is provider/profile cooldown; `models status --probe` can contribute to cooldown state

## Summary

When one profile per provider is configured, a single rate limit or timeout can put that provider profile into cooldown. The fallback summary then reports each model as failed, even though later candidates were skipped due to provider/profile availability rather than model-level capacity.

In practice this reads like model-specific quota failures, but the root cause is often provider/profile cooldown state.

Additionally, `openclaw models status --probe` uses live agent runs that currently participate in auth-profile failure marking. Probe timeouts can therefore update cooldown state and influence later production traffic.

## Environment

- OpenClaw: `2026.2.6-3 (85ed6c7)`
- OS: macOS (Apple Silicon)
- Date observed: `2026-02-13`
- Agent: `captain-rusty`
- Config shape: one Google Antigravity OAuth profile + one OpenAI Codex OAuth profile, multiple model fallbacks per provider

## Repro (observed)

1. Configure fallback chain with multiple models on the same provider and only one auth profile for that provider.
2. Trigger a prompt that hits a provider/model 429 or timeout on the first candidate.
3. Let fallback continue.
4. Inspect error surfaced to user and logs.

## Actual output (example)

At `2026-02-13T18:36:28Z`, logs showed:

`All models failed (6):`
`google-antigravity/claude-opus-4-6-thinking: Cloud Code Assist API error (429)... (rate_limit) |`
`google-antigravity/claude-sonnet-4-5-thinking: No available auth profile for google-antigravity (all in cooldown or unavailable). (rate_limit) |`
`google-antigravity/gemini-3-pro-high: No available auth profile for google-antigravity (all in cooldown or unavailable). (rate_limit) |`
`google-antigravity/gemini-3-flash: No available auth profile for google-antigravity (all in cooldown or unavailable). (rate_limit) |`
`openai-codex/gpt-5.3-codex: Provider openai-codex is in cooldown (all profiles unavailable) (rate_limit) |`
`openai-codex/gpt-5.1-codex-mini: Provider openai-codex is in cooldown (all profiles unavailable) (rate_limit)`

## Why this is a problem

1. UX attribution is confusing. The message is model-indexed but many entries are provider/profile availability skips, not model-level failures.
2. Operators interpret this as "all those models are quota exhausted" when root cause can be "single profile in cooldown".
3. Probe traffic can participate in cooldown marking. With default probe timeout (`8000ms`), slow responses can be marked as failure and affect real runs.

## Code pointers

- Fallback pre-skip when all provider profiles are in cooldown:
  - `src/agents/model-fallback.ts:252`
  - `src/agents/model-fallback.ts:257`
- Final per-model summary string construction:
  - `src/agents/model-fallback.ts:307`
  - `src/agents/model-fallback.ts:318`
- Probe sessions identified but still mark profile failures:
  - `src/agents/pi-embedded-runner/run.ts:175`
  - `src/agents/pi-embedded-runner/run.ts:681`
  - `src/agents/pi-embedded-runner/run.ts:769`
- Probe command uses `runEmbeddedPiAgent` with `probe-` session ids:
  - `src/commands/models/list.probe.ts:313`
  - `src/commands/models/list.probe.ts:319`

## Expected behavior

1. Error text should clearly separate:
   - model execution failures
   - provider/profile skipped due cooldown/unavailable auth
2. Probe runs should be diagnostic-only by default and not mutate auth profile cooldown state.

## Suggested fix

1. Add a runner option for probe mode (or "do not penalize auth profiles") and bypass `markAuthProfileFailure` when enabled.
2. In fallback summary, keep `provider/model:` formatting and label provider-cooldown entries as skipped-not-attempted.
3. Add tests for:
   - probe run does not update `cooldownUntil`
   - fallback summary distinguishes model failures from provider/profile skip reasons
