# Anthropic `max_tokens >= 1` cron failure investigation

## Verdict

This is a real runtime bug, but it is not specific to cron.

The cron isolated-agent path does not synthesize `maxTokens = 0`. The more likely failure is that an Anthropic Messages run received a resolved model or extra params with `maxTokens: 0`, and the Anthropic Messages transport forwarded that invalid value instead of rejecting or normalizing it.

## Live symptom

- Failed cron run: `00cf8508-7450-4092-8f4b-c5020851652b`
- Provider/model: `anthropic` / `claude-haiku-4-5`
- Agent session: `f55d3b83-e059-454e-8049-56c0fddaf40c`
- Error: `LLM request rejected: max_tokens: must be greater than or equal to 1`

The session transcript shows the run switched to `anthropic/claude-haiku-4-5`, changed thinking to `off`, and then immediately failed with Anthropic's `invalid_request_error`. That rules out a cron-only reasoning-budget issue on the failing turn itself.

## What the cron path does

The isolated cron executor forwards provider/model/thinking choices into the embedded runner, but it does not set `maxTokens` itself.

- `src/cron/isolated-agent/run-executor.ts:142-186` calls `runEmbeddedPiAgent(...)` with `provider`, `model`, `thinkLevel`, and timeout settings, but no `maxTokens`.
- `src/cron/isolated-agent/run.ts:546-558` restores `contextTokens` using `resolvePositiveContextTokens(...)`, which already rejects non-positive values.

Conclusion: cron is the surface where the bug appeared, not the place where `0` is created.

## Where `0` can leak in

### 1. Extra params can forward `maxTokens: 0` unchanged

`src/agents/pi-embedded-runner/extra-params.ts:247-249` copies any numeric `extraParams.maxTokens` into stream options without validating that it is positive.

That means any hidden agent/model/default param override can force `options.maxTokens = 0`.

### 2. Resolved models are not normalized to positive `maxTokens`

Model resolution keeps a resolved model's `maxTokens` as-is.

- `src/agents/pi-embedded-runner/model.ts:129-191` normalizes input/api/baseUrl, but not token limits.
- `src/agents/pi-embedded-runner/model.ts:336` preserves `configuredModel?.maxTokens ?? discoveredModel.maxTokens`.
- `src/agents/pi-embedded-runner/model.provider-normalization.ts:4-9` only delegates to compatibility normalization; it does not clamp token limits.

By contrast, the fallback path for a purely configured inline provider model is safe:

- `src/agents/pi-embedded-runner/model.ts:531-534` defaults missing `maxTokens` to `DEFAULT_CONTEXT_TOKENS`.

That makes the visible Anthropic config stanza unlikely to be the direct cause. The visible config defines `contextTokens` only, not `maxTokens`, so a plain inline-config path would have defaulted to a positive value.

### 3. Anthropic Messages transport accepts `0`

This is the core bug.

- `src/agents/anthropic-transport-stream.ts:558-561` computes `baseMaxTokens = options?.maxTokens || Math.min(model.maxTokens, 32_000)`.
- `src/agents/anthropic-transport-stream.ts:489-494` sends `max_tokens: options?.maxTokens || defaultMaxTokens`.
- `src/agents/anthropic-transport-stream.ts:131-151` can return `{ maxTokens: 0, thinkingBudget: 0 }` when `modelMaxTokens` is `0`.

So if `model.maxTokens` is `0`, the Anthropic Messages request will carry `max_tokens: 0`.

The failing live turn had thinking disabled, so the simplest bad path is:

1. resolved Anthropic model has `maxTokens: 0`
2. transport computes `defaultMaxTokens = Math.min(0, 32_000) = 0`
3. transport sends `max_tokens: 0`
4. Anthropic rejects the request

## Strong comparison: Anthropic Vertex already guards this correctly

`src/agents/anthropic-vertex-stream.ts:15-35` only accepts positive finite values for both `requestedMaxTokens` and `modelMaxTokens`. If neither is positive, it omits `maxTokens` entirely instead of sending `0`.

That is the behavior the Anthropic Messages transport should match.

## Most likely root cause

The most likely root cause is:

1. a resolved Anthropic Messages model reached runtime with `maxTokens: 0`
2. the Anthropic Messages transport trusted that value and emitted `max_tokens: 0`

I could not prove from repo code alone exactly which upstream runtime source produced the zero on the live host. The two realistic sources are:

1. provider/runtime model resolution returning a model with `maxTokens: 0`
2. hidden extra params setting `maxTokens: 0`

The first is more likely for this specific failure because:

- the visible live config does not show an Anthropic `params.maxTokens` override
- the failing session had `thinkingLevel: off`, so no reasoning math was needed to create the invalid request
- the Anthropic model in visible config omits `maxTokens`, which means some other resolved runtime surface had to provide the final bad value

## How to reproduce

The smallest repro shape is:

1. run any embedded Anthropic Messages turn, not necessarily cron
2. use a resolved model with `api: "anthropic-messages"` and `maxTokens: 0`
3. call the transport without overriding `options.maxTokens`

Expected result:

- `src/agents/anthropic-transport-stream.ts` computes `defaultMaxTokens = 0`
- outbound payload contains `max_tokens: 0`
- Anthropic returns `invalid_request_error: max_tokens: must be greater than or equal to 1`

A second repro shape is:

1. set agent/model/default extra params so `maxTokens: 0`
2. let `src/agents/pi-embedded-runner/extra-params.ts:247-249` forward it
3. run any Anthropic Messages turn

## Cleanest fix

The cleanest fix is to harden the Anthropic Messages path at the transport boundary and, ideally, also normalize earlier.

### Required fix

Make the Anthropic Messages transport treat non-positive `requestedMaxTokens` and `model.maxTokens` as absent, matching the Vertex implementation.

Concretely:

- replace `||` fallback logic in `src/agents/anthropic-transport-stream.ts`
- introduce the same positive-finite guard used by `src/agents/anthropic-vertex-stream.ts:15-35`
- never send `max_tokens` when the resolved value is missing or non-positive

### Recommended defense in depth

- reject or drop `extraParams.maxTokens <= 0` in `src/agents/pi-embedded-runner/extra-params.ts`
- normalize resolved models so `maxTokens` is either a positive integer or omitted

The transport hardening is the must-fix because it prevents bad requests even if some upstream runtime surface still emits `0`.

## Regression coverage to add with the fix

1. Anthropic Messages transport test: `model.maxTokens = 0` should not send `max_tokens: 0`
2. Anthropic Messages transport test: `options.maxTokens = 0` should not send `max_tokens: 0`
3. Extra params test: `maxTokens: 0` should be dropped or rejected before transport

## Bottom line

This looks like a genuine OpenClaw bug in Anthropic Messages request assembly and token-limit validation. Cron only exposed it because an isolated run happened to resolve Anthropic Haiku with an invalid `maxTokens` value.
