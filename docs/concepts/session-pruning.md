---
title: "Session Pruning"
summary: "Trimming old tool results to keep context lean and caching efficient"
read_when:
  - You want to reduce context growth from tool outputs
  - You want to understand Anthropic prompt cache optimization
---

# Session Pruning

Session pruning trims **old tool results** from the context before each LLM
call. It reduces context bloat from accumulated tool outputs (exec results, file
reads, search results) without touching your conversation messages.

<Info>
Pruning is in-memory only -- it does not modify the on-disk session transcript.
Your full history is always preserved.
</Info>

## Why it matters

Long sessions accumulate tool output that inflates the context window. This
increases cost and can force [compaction](/concepts/compaction) sooner than
necessary.

Pruning is especially valuable for **Anthropic prompt caching**. After the cache
TTL expires, the next request re-caches the full prompt. Pruning reduces the
cache-write size, directly lowering cost.

## How it works

1. Wait for the cache TTL to expire (default 5 minutes).
2. Find old tool results (user and assistant messages are never touched).
3. **Soft-trim** oversized results -- keep the head and tail, insert `...`.
4. **Hard-clear** the rest -- replace with a placeholder.
5. Reset the TTL so follow-up requests reuse the fresh cache.

## Smart defaults

OpenClaw auto-enables pruning for Anthropic profiles:

| Profile type         | Pruning enabled | Heartbeat |
| -------------------- | --------------- | --------- |
| OAuth or setup-token | Yes             | 1 hour    |
| API key              | Yes             | 30 min    |

If you set explicit values, OpenClaw does not override them.

## Enable or disable

Pruning is off by default for non-Anthropic providers. To enable:

```json5
{
  agents: {
    defaults: {
      contextPruning: { mode: "cache-ttl", ttl: "5m" },
    },
  },
}
```

To disable: set `mode: "off"`.

## Pruning vs compaction

|            | Pruning            | Compaction              |
| ---------- | ------------------ | ----------------------- |
| **What**   | Trims tool results | Summarizes conversation |
| **Saved?** | No (per-request)   | Yes (in transcript)     |
| **Scope**  | Tool results only  | Entire conversation     |

They complement each other -- pruning keeps tool output lean between
compaction cycles.

## Further reading

- [Compaction](/concepts/compaction) -- summarization-based context reduction
- [Gateway Configuration](/gateway/configuration) -- all pruning config knobs
  (`contextPruning.*`)
