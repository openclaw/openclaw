# Adaptive Thinking Heuristics Design

## Goal

Teach the embedded OpenClaw agent when to call `set_thinking_level` so it adapts reasoning intentionally for harder one-off tasks without adding hidden runtime automation.

## Scope

- Add prompt guidance for when to keep, raise, or persist thinking changes.
- Reinforce the same intended usage through the `set_thinking_level` tool description.
- Hide `set_thinking_level` and the adaptive-thinking prompt section when the active provider/model already supports native adaptive thinking.
- Verify the generated prompt and registered tool metadata include the new guidance only when the tool is available.

## Non-Goals

- No automatic runtime controller that changes thinking without an explicit tool call.
- No transcript, status, or export visibility changes in this slice.
- No changes to thinking resolution, persistence, or provider capability logic.

## Decision

Use prompt-guided heuristics rather than hidden automation.

This keeps behavior visible, easy to tune, and easy to test. The model receives explicit rules about when to call `set_thinking_level`, and the tool remains the only mechanism that actually changes thinking when native adaptive support is not already available.

## Availability Gate

The `set_thinking_level` tool should be gated per active provider/model pair, not per provider.

- If `supportsNativeAdaptiveThinking(provider, model)` is true, do not register `set_thinking_level`.
- If the tool is not registered, the adaptive-thinking prompt section must also stay hidden.
- If native adaptive support is false or unavailable, expose the tool and prompt guidance as normal.

This keeps the agent surface aligned with the actual need for the tool.

## Prompt Policy

The agent should be told to:

- keep the current thinking level unless task complexity clearly changes
- use `scope: "turn"` for one-off difficult work
- use `scope: "session"` only when the user clearly wants a lasting change
- raise thinking for complex debugging, multi-step design, subtle refactors, and correctness-critical tasks
- keep default or low thinking for small mechanical edits, simple lookups, formatting, and straightforward commands
- avoid repeatedly changing thinking unless the task materially changes

## Architecture

### System prompt guidance

Add a small adaptive-thinking section to `src/agents/system-prompt.ts` so eligible embedded runs get the same policy.

This is the right place because it is the shared prompt builder and already includes behavior-level sections like skills, safety, messaging, and runtime guidance. The section should remain driven by tool availability so it disappears automatically when `set_thinking_level` is gated off.

### Tool summary reinforcement

Update the `set_thinking_level` tool description in `src/agents/tools/set-thinking-level-tool.ts` so the tool summary seen by the model matches the prompt policy.

This should stay short and action-oriented.

### Tool registry gating

Gate `set_thinking_level` registration in `src/agents/openclaw-tools.ts` using the existing native-adaptive capability helper in `src/auto-reply/thinking.ts`.

Do not duplicate provider/model capability detection logic in the tool registry.

## Testing

Use prompt-generation tests rather than model-behavior tests.

Coverage should prove:

- the generated system prompt includes the adaptive-thinking guidance when native adaptive support is unavailable
- the generated system prompt omits the adaptive-thinking guidance when native adaptive support is available
- the wording mentions `turn` vs `session` expectations when the tool is available
- the `set_thinking_level` tool is hidden for native-adaptive models and exposed otherwise

## Follow-Up

The next slice after this one should improve visibility of thinking changes in transcripts, exports, CLI status, and TUI/UI views.
