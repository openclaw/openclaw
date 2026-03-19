## Summary

Adds a new `message:sending` internal hook event and a bundled `mail-buttons` hook that automatically injects interactive Gmail action buttons (Archive, Reply, Delete, etc.) into outbound messages containing Gmail thread IDs.

## Motivation

Currently, adding interactive buttons to outgoing messages depends entirely on LLM behavior (prompt-level instructions). This is unreliable -- the LLM may forget, hallucinate callback formats, or skip buttons entirely.

This PR introduces **code-level enforcement**: a bundled hook that fires in the outbound delivery pipeline *before* the message is sent, and deterministically injects buttons when a Gmail thread ID is detected.

## Changes

### Core: `message:sending` internal hook (`src/hooks/internal-hooks.ts`)
- New `MessageSendingHookContext` and `MessageSendingHookEvent` types
- New `isMessageSendingEvent()` type guard
- Fires *before* plugin `message_sending` hooks in the delivery pipeline

### Outbound pipeline (`src/infra/outbound/deliver.ts`)
- `applyMessageSendingHook` now triggers the internal hook first, then passes the result to plugin hooks
- Propagates `interactive` and `channelData` through the full pipeline
- Internal hooks work even when plugin hooks are disabled

### Plugin hook types (`src/plugins/types.ts`, `src/plugins/hooks.ts`)
- `PluginHookMessageSendingResult` extended with `interactive` and `channelData` fields
- `runMessageSending` reducer merges the new fields

### Bundled hook: `mail-buttons` (`src/hooks/bundled/mail-buttons/`)
- `handler.ts`: Detects Gmail thread IDs (16 hex chars) in outbound messages and injects configurable interactive buttons
- `handler.test.ts`: 8 test cases covering detection, disabled state, custom config, error resilience, and hook system integration
- `HOOK.md`: Documentation and metadata

## Callback Format

`mb:<action>:<threadId>` (e.g., `mb:archive:19d05a032de0fce7`)

For label actions: `mb:label:<labelName>:<threadId>`

## Backward Compatibility

- All new fields are optional -- existing plugins continue to work unchanged
- Internal hooks are additive; they don't alter the existing plugin hook flow
- The mail-buttons hook is disabled by default if no config is present

## Tests

```
vitest run src/hooks/bundled/mail-buttons/handler.test.ts
8 tests passed (22ms)
```
