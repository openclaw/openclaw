---
title: "Session Pruning"
summary: "How session pruning trims old tool results to reduce context bloat and improve cache efficiency"
read_when:
  - You want to reduce LLM context growth from tool outputs
  - You are tuning agents.defaults.contextPruning
---

# Session Pruning

Session pruning trims **old tool results** from the in-memory context before
each LLM call. It does **not** rewrite the on-disk session history (JSONL) --
it only affects what gets sent to the model for that request.

## Why prune

Long-running sessions accumulate tool outputs (exec results, file reads, search
results). These inflate the context window, increasing cost and eventually
forcing [compaction](/concepts/compaction). Pruning removes stale tool output so
the model sees a leaner context on each turn.

Pruning is also important for **Anthropic prompt caching**. When a session goes
idle past the cache TTL, the next request re-caches the full prompt. Pruning
reduces the cache-write size for that first post-TTL request, which directly
reduces cost.

## How it works

Pruning runs in `cache-ttl` mode, which is the only supported mode:

1. **Check the clock** -- pruning only runs if the last Anthropic API call for
   the session is older than `ttl` (default `5m`).
2. **Find prunable messages** -- only `toolResult` messages are eligible. User
   and assistant messages are never modified.
3. **Protect recent context** -- the last `keepLastAssistants` assistant
   messages (default `3`) and all tool results after that cutoff are preserved.
4. **Soft-trim** oversized tool results -- keep the head and tail, insert
   `...`, and append a note with the original size.
5. **Hard-clear** remaining eligible results -- replace the entire content with
   a placeholder.
6. **Reset the TTL** -- subsequent requests keep cache until `ttl` expires
   again.

### What gets skipped

- Tool results containing **image blocks** are never trimmed.
- If there are not enough assistant messages to establish the cutoff, pruning
  is skipped entirely.
- Pruning currently only activates for Anthropic API calls (and OpenRouter
  Anthropic models).

## Smart defaults

OpenClaw auto-configures pruning for Anthropic profiles:

| Profile type         | Pruning             | Heartbeat | Cache retention    |
| -------------------- | ------------------- | --------- | ------------------ |
| OAuth or setup-token | `cache-ttl` enabled | `1h`      | (provider default) |
| API key              | `cache-ttl` enabled | `30m`     | `short` (5 min)    |

If you set any of these values explicitly, OpenClaw does not override them.

Match `ttl` to your model `cacheRetention` policy for best results (`short` =
5 min, `long` = 1 hour).

## Pruning vs compaction

|                | Pruning                           | Compaction                      |
| -------------- | --------------------------------- | ------------------------------- |
| **What**       | Trims tool result messages        | Summarizes conversation history |
| **Persisted?** | No (in-memory, per request)       | Yes (in JSONL transcript)       |
| **Scope**      | Tool results only                 | Entire conversation             |
| **Trigger**    | Every LLM call (when TTL expired) | Context window threshold        |

Built-in tools already truncate their own output. Pruning is an additional layer
that prevents long-running chats from accumulating too much tool output over
time. See [Compaction](/concepts/compaction) for the summarization approach.

## Configuration

### Defaults (when enabled)

| Setting                 | Default                             | Description                                      |
| ----------------------- | ----------------------------------- | ------------------------------------------------ |
| `ttl`                   | `5m`                                | Prune only after this idle period                |
| `keepLastAssistants`    | `3`                                 | Protect tool results near recent assistant turns |
| `softTrimRatio`         | `0.3`                               | Context ratio for soft-trim eligibility          |
| `hardClearRatio`        | `0.5`                               | Context ratio for hard-clear eligibility         |
| `minPrunableToolChars`  | `50000`                             | Minimum tool result size to consider             |
| `softTrim.maxChars`     | `4000`                              | Max chars after soft-trim                        |
| `softTrim.headChars`    | `1500`                              | Head portion to keep                             |
| `softTrim.tailChars`    | `1500`                              | Tail portion to keep                             |
| `hardClear.enabled`     | `true`                              | Enable hard-clear stage                          |
| `hardClear.placeholder` | `[Old tool result content cleared]` | Replacement text                                 |

### Examples

Disable pruning (default state):

```json5
{
  agents: {
    defaults: {
      contextPruning: { mode: "off" },
    },
  },
}
```

Enable TTL-aware pruning:

```json5
{
  agents: {
    defaults: {
      contextPruning: { mode: "cache-ttl", ttl: "5m" },
    },
  },
}
```

Restrict pruning to specific tools:

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl",
        tools: {
          allow: ["exec", "read"],
          deny: ["*image*"],
        },
      },
    },
  },
}
```

Tool selection supports `*` wildcards, deny wins over allow, matching is
case-insensitive, and an empty allow list means all tools are allowed.

## Context window estimation

Pruning estimates the context window (chars = tokens x 4). The base window is
resolved in this order:

1. `models.providers.*.models[].contextWindow` override.
2. Model definition `contextWindow` from the model registry.
3. Default `200000` tokens.

If `agents.defaults.contextTokens` is set, it caps the resolved window.

## Related

- [Compaction](/concepts/compaction) -- summarization-based context reduction
- [Session Management](/concepts/session) -- session lifecycle and routing
- [Gateway Configuration](/gateway/configuration) -- full config reference
