# PR: Plugin messageMeta namespace isolation and display-strip patterns

**Branch:** `fix/memory-lancedb-meta-strip-leak`
**Status:** Ready for review

## Problem

When `memory-lancedb` auto-recall injects `<relevant-memories>` context into user prompts, the raw XML tags are visible in the chat UI and API responses. This is internal scaffolding that should never be shown to users.

## Solution

### 1. Plugin-driven display-strip patterns via `messageMeta`

Instead of only relying on hardcoded regex, `memory-lancedb` now declares its own `displayStripPatterns` in the hook result's `messageMeta`. The patterns are persisted alongside the message so the UI can strip injected context at display time.

The plugin returns flat meta — it does **not** need to know its own plugin ID:

```typescript
return {
  prependContext: formatRelevantMemoriesContext(results),
  messageMeta: {
    displayStripPatterns: [
      {
        regex:
          "<\\s*relevant[-_]memories\\b[^>]*>[\\s\\S]*?<\\s*/\\s*relevant[-_]memories\\s*>\\s*",
      },
    ],
  },
};
```

### 2. System-level namespace isolation (anti-tampering)

The hook runner (`src/plugins/hooks.ts`) automatically wraps every plugin's `messageMeta` under `{ [pluginId]: ... }` **before merging**. This is done by `namespaceMessageMeta()` inside `runModifyingHook()`.

**A plugin returning:**

```typescript
{ displayStripPatterns: [...] }
```

**Becomes after system wrapping:**

```typescript
{ "memory-lancedb": { displayStripPatterns: [...] } }
```

This means:

- Plugins **cannot** write into another plugin's namespace — the runner controls the key.
- A malicious plugin returning `{ "memory-lancedb": { ... } }` would end up nested as `{ "malicious-plugin": { "memory-lancedb": { ... } } }` — harmless.
- Each plugin's data is naturally isolated without needing allowlists or signatures.

### 3. UI consumption

The UI (`ui/src/ui/chat/message-extract.ts`) reads **only** `messageMeta["memory-lancedb"].displayStripPatterns`. Patterns from other plugin namespaces are completely ignored.

A hardcoded fallback (`stripRelevantMemoriesTags`) still runs when `messageMeta` is absent (e.g. sessions created before this feature, or API paths that don't pass messageMeta through).

## On the hardcoded `"memory-lancedb"` reference in the UI

The UI reads `messageMeta["memory-lancedb"]` — this is intentional and **not** a new pattern. The codebase already has extensive hardcoded handling for `memory-lancedb` and its `<relevant-memories>` tags:

| Location                                               | Hardcoded reference                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `src/shared/text/assistant-visible-text.ts`            | `stripRelevantMemoriesTags()` — shared function with hardcoded `MEMORY_TAG_RE` regex, used by **5+ call sites** |
| `src/auto-reply/reply/normalize-reply.ts`              | Hardcoded call to `stripRelevantMemoriesTags()` as outbound safety net for all channels                         |
| `src/tui/tui-formatters.ts`                            | Hardcoded `stripRelevantMemoriesTags()` in TUI message formatting                                               |
| `src/gateway/server-methods/chat.ts`                   | **3 separate** hardcoded `stripRelevantMemoriesTags()` calls in chat history API                                |
| `extensions/imessage/src/monitor/reflection-guard.ts`  | Hardcoded `RELEVANT_MEMORIES_TAG_RE` in reflection detection patterns                                           |
| `extensions/imessage/src/monitor/sanitize-outbound.ts` | Calls `stripAssistantInternalScaffolding()` which internally calls `stripRelevantMemoriesTags()`                |
| `src/plugin-sdk/memory-lancedb.ts`                     | Dedicated SDK entry point for the bundled memory-lancedb plugin                                                 |
| `src/agents/pi-embedded-runner/run/attempt.ts`         | Comment explicitly references `memory-lancedb` by name                                                          |

`memory-lancedb` is a **first-party bundled plugin** with its own SDK sub-path (`openclaw/plugin-sdk/memory-lancedb`). The `<relevant-memories>` tag format is already a de facto internal protocol between this plugin and the core display/sanitization layers.

Our change actually **improves** the situation: instead of adding more hardcoded regex across the codebase, we let the plugin declare its own strip patterns via `messageMeta`, making the system more data-driven and extensible.

## Files changed (14 files, +418/-19)

| File                                             | Change                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `extensions/memory-lancedb/index.ts`             | Return `displayStripPatterns` in `messageMeta` from `before_agent_start` hook                     |
| `src/plugins/hooks.ts`                           | Add `namespaceMessageMeta()` + `mergeMessageMeta()` for plugin namespace isolation                |
| `src/plugins/types.ts`                           | Update `messageMeta` JSDoc                                                                        |
| `src/agents/pi-embedded-runner/run/attempt.ts`   | Add `mergeShallowMeta()` + one-shot interceptor to persist `messageMeta` on user messages         |
| `ui/src/ui/chat/message-extract.ts`              | Add `stripDisplayPatterns()` reading from `messageMeta["memory-lancedb"]` with hardcoded fallback |
| `src/auto-reply/reply/normalize-reply.ts`        | Add `stripRelevantMemoriesTags` to outbound reply normalization                                   |
| `src/gateway/server-methods/chat.ts`             | Add `stripRelevantMemoriesTags` to chat history API sanitization                                  |
| `src/tui/tui-formatters.ts`                      | Add `stripRelevantMemoriesTags` to TUI message formatting                                         |
| `src/tui/components/assistant-message.ts`        | Strip `<relevant-memories>` from assistant message display                                        |
| `src/shared/text/assistant-visible-text.ts`      | Make `stripRelevantMemoriesTags` handle edge cases                                                |
| `ui/src/ui/chat/message-extract.test.ts`         | 6 new tests for `stripDisplayPatterns` + namespace isolation                                      |
| `src/auto-reply/reply/normalize-reply.test.ts`   | Tests for outbound stripping                                                                      |
| `src/tui/tui-formatters.test.ts`                 | Tests for TUI stripping                                                                           |
| `src/shared/text/assistant-visible-text.test.ts` | Tests for shared strip function                                                                   |
