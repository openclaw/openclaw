---
summary: "How OpenClaw compacts long sessions to stay within model context limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
  - You want to tune compaction behavior or use a custom context engine
title: "Compaction"
---

# Compaction

Every model has a **context window** -- the maximum number of tokens it can see
at once. As a conversation grows, it eventually approaches that limit. OpenClaw
**compacts** older history into a summary so the session can continue without
losing important context.

## How compaction works

Compaction is a three-step process:

1. **Summarize** older conversation turns into a compact summary.
2. **Persist** the summary as a `compaction` entry in the session transcript
   (JSONL).
3. **Keep** recent messages after the compaction point intact.

After compaction, future turns see the summary plus all messages after the
compaction point. The on-disk transcript retains the full history -- compaction
only changes what gets loaded into the model context.

## Auto-compaction

Auto-compaction is **on by default**. It triggers in two situations:

1. **Threshold maintenance** -- after a successful turn, when estimated context
   usage exceeds `contextWindow - reserveTokens`.
2. **Overflow recovery** -- the model returns a context-overflow error. OpenClaw
   compacts and retries the request.

When auto-compaction runs you will see:

- `Auto-compaction complete` in verbose mode
- `/status` showing `Compactions: <count>`

### Pre-compaction memory flush

Before compacting, OpenClaw can run a **silent turn** that reminds the model to
write durable notes to disk. This prevents important context from being lost in
the summary. The flush is controlled by `agents.defaults.compaction.memoryFlush`
and runs once per compaction cycle. See [Memory](/concepts/memory) for details.

## Manual compaction

Use `/compact` in any chat to force a compaction pass. You can optionally add
instructions to guide the summary:

```
/compact Focus on decisions and open questions
```

## Configuration

### Compaction model

By default, compaction uses the agent's primary model. You can override this
with a different model for summarization -- useful when your primary model is
small or local and you want a more capable summarizer:

```json5
{
  agents: {
    defaults: {
      compaction: {
        model: "openrouter/anthropic/claude-sonnet-4-6",
      },
    },
  },
}
```

### Reserve tokens and floor

- `reserveTokens` -- headroom reserved for prompts and the next model output
  (Pi runtime default: `16384`).
- `reserveTokensFloor` -- minimum reserve enforced by OpenClaw (default:
  `20000`). Set to `0` to disable.
- `keepRecentTokens` -- how many tokens of recent conversation to preserve
  during compaction (default: `20000`).

### Identifier preservation

Compaction summaries preserve opaque identifiers by default
(`identifierPolicy: "strict"`). Override with:

- `"off"` -- no special identifier handling.
- `"custom"` -- provide your own instructions via `identifierInstructions`.

### Memory flush

```json5
{
  agents: {
    defaults: {
      compaction: {
        memoryFlush: {
          enabled: true, // default
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

The flush triggers when context usage crosses
`contextWindow - reserveTokensFloor - softThresholdTokens`. It runs silently
(the user sees nothing) and is skipped when the workspace is read-only.

## Compaction vs pruning

|                  | Compaction                     | Session pruning                  |
| ---------------- | ------------------------------ | -------------------------------- |
| **What it does** | Summarizes older conversation  | Trims old tool results           |
| **Persisted?**   | Yes (in JSONL transcript)      | No (in-memory only, per request) |
| **Scope**        | Entire conversation history    | Tool result messages only        |
| **Frequency**    | Once when threshold is reached | Every LLM call (when enabled)    |

See [Session Pruning](/concepts/session-pruning) for pruning details.

## OpenAI server-side compaction

OpenClaw also supports OpenAI Responses server-side compaction for compatible
direct OpenAI models. This is separate from local compaction and can run
alongside it:

- **Local compaction** -- OpenClaw summarizes and persists into session JSONL.
- **Server-side compaction** -- OpenAI compacts context on the provider side when
  `store` + `context_management` are enabled.

See [OpenAI provider](/providers/openai) for model params and overrides.

## Custom context engines

Compaction behavior is owned by the active
[context engine](/concepts/context-engine). The built-in engine uses the
summarization described above. Plugin engines (selected via
`plugins.slots.contextEngine`) can implement any strategy -- DAG summaries,
vector retrieval, incremental condensation, etc.

When a plugin engine sets `ownsCompaction: true`, OpenClaw delegates all
compaction decisions to the engine and does not run built-in auto-compaction.

When `ownsCompaction` is `false` or unset, the built-in auto-compaction still
runs, but the engine's `compact()` method handles `/compact` and overflow
recovery. If you are building a non-owning engine, implement `compact()` by
calling `delegateCompactionToRuntime(...)` from `openclaw/plugin-sdk/core`.

## Troubleshooting

**Compaction triggers too often?**

- Check the model's context window -- small models compact more frequently.
- High `reserveTokens` relative to the context window can trigger early
  compaction.
- Large tool outputs accumulate fast. Enable
  [session pruning](/concepts/session-pruning) to reduce tool-result buildup.

**Context feels stale after compaction?**

- Use `/compact Focus on <topic>` to guide the summary.
- Increase `keepRecentTokens` to preserve more recent conversation.
- Enable the [memory flush](/concepts/memory) so durable notes survive
  compaction.

**Need a fresh start?**

- `/new` or `/reset` starts a new session ID without compacting.

For the full internal lifecycle (store schema, transcript structure, Pi runtime
semantics), see
[Session Management Deep Dive](/reference/session-management-compaction).
