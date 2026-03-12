# Adaptive Thinking Tool Design

## Goal

Add a first-step adaptive thinking feature by introducing a `set_thinking_level` tool that OpenClaw agents can call mid-run to change thinking behavior for the current run or the session default.

## Scope

- Add a new built-in agent tool: `set_thinking_level`.
- Support two scopes:
  - `turn`: applies for the rest of the current run only.
  - `session`: persists as the session default and also takes effect immediately in the current run.
- Reuse existing thinking level validation, defaults, and provider-specific semantics.

## Non-Goals

- No heuristic engine that decides when to change thinking levels automatically.
- No broad settings tool for unrelated session state.
- No new user-facing slash command in this first pass.

## Requirements

### Tool contract

The tool accepts:

- `level`: requested thinking level.
- `scope`: `turn` or `session`.
- `clear` (optional): clear the selected scope override.

The tool returns:

- previous requested level
- new requested level
- effective level used for the active provider/model
- scope
- whether the change was persisted
- an explanation when requested and effective differ

### Thinking semantics

The system must distinguish between:

- `requested` thinking: what the agent asked for
- `effective` thinking: what the active provider/model can actually use

`adaptive` is semantic intent, not a guaranteed transport-level capability.

Best-effort handling:

- Native adaptive providers keep `adaptive`.
- Providers with graded reasoning but no native adaptive support downgrade to a stable graded level.
- Binary reasoning providers map non-`off` adaptive behavior to binary enabled behavior.
- Providers without reasoning support reject the request clearly.

### Resolution order

For every model call, resolve requested thinking in this order:

1. run-local `turn` override
2. session override
3. config default
4. provider/model fallback

Then resolve the effective provider-safe behavior from the requested level.

## Architecture

### Shared thinking resolver

Add a shared resolver that:

- computes the requested thinking level from overrides and defaults
- computes the effective provider/model behavior from the requested level
- produces downgrade metadata for tool responses and debugging

This keeps `set_thinking_level`, existing defaults, and provider wrappers aligned.

### Run-local mutable state

The current embedded runner captures a fixed thinking level at run start. To support mid-run changes, add mutable run-local thinking state that can be updated by tools and read again before each model request.

This state should:

- store the current run override
- support clear/reset
- be available to the tool implementation
- be consulted dynamically by the model-call wrapper path

### Session persistence

For `scope: session`, write through the existing session patch/store path so validation and compatibility remain centralized.

Persist the requested value, not the downgraded transport value.

## Provider handling

Current repo behavior already varies by provider. The new tool should align with that behavior rather than inventing stricter semantics.

- Anthropic Claude 4.6 family already defaults to `adaptive`.
- Some proxy paths downgrade `adaptive` to a graded effort.
- Moonshot reduces non-`off` thinking to enabled/disabled.
- Z.AI exposes binary thinking labels.

The new tool should surface that difference explicitly in its result.

## Error handling

- Invalid thinking levels reuse existing validation hints.
- Unsupported `xhigh` keeps current gating behavior.
- Unsupported reasoning providers return a clear tool error.
- Session persistence failures bubble up as tool errors.

## Testing

Follow TDD:

1. write failing tests for shared resolution behavior
2. write failing tests for tool behavior
3. write failing tests for mid-run application
4. implement minimal code to satisfy each test set

Coverage should include:

- `adaptive` best-effort mapping
- `turn` vs `session` persistence semantics
- clear/reset behavior
- immediate effect during the same run
- provider-specific downgrade reporting

## Likely Files

- `src/agents/tools/set-thinking-level-tool.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/pi-tools.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/extra-params.ts`
- `src/auto-reply/thinking.ts`
- `src/agents/model-selection.ts`
- new or updated tests near those modules
