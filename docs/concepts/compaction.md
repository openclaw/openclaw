---
summary: "How OpenClaw summarizes long conversations to stay within model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
---

# Compaction

Every model has a context window -- the maximum number of tokens it can process.
When a conversation approaches that limit, OpenClaw **compacts** older messages
into a summary so the chat can continue.

## How it works

1. Older conversation turns are summarized into a compact entry.
2. The summary is saved in the session transcript.
3. Recent messages are kept intact.

The full conversation history stays on disk. Compaction only changes what the
model sees on the next turn.

## Auto-compaction

Auto-compaction is on by default. It runs when the session nears the context
limit, or when the model returns a context-overflow error (in which case
OpenClaw compacts and retries).

<Info>
Before compacting, OpenClaw automatically reminds the agent to save important
notes to [memory](/concepts/memory) files. This prevents context loss.
</Info>

## Manual compaction

Type `/compact` in any chat to force a compaction. Add instructions to guide
the summary:

```
/compact Focus on the API design decisions
```

## Using a different model

By default, compaction uses your agent's primary model. You can use a more
capable model for better summaries:

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

## Compaction start notice

By default, compaction runs silently. To show a brief notice when compaction
starts, enable `notifyUser`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        notifyUser: true,
      },
    },
  },
}
```

When enabled, the user sees a short message (for example, "Compacting
context...") at the start of each compaction run.

## Compaction vs pruning

|                  | Compaction                    | Pruning                          |
| ---------------- | ----------------------------- | -------------------------------- |
| **What it does** | Summarizes older conversation | Trims old tool results           |
| **Saved?**       | Yes (in session transcript)   | No (in-memory only, per request) |
| **Scope**        | Entire conversation           | Tool results only                |

[Session pruning](/concepts/session-pruning) is a lighter-weight complement that
trims tool output without summarizing.

## Troubleshooting

**Compacting too often?** The model's context window may be small, or tool
outputs may be large. Try enabling
[session pruning](/concepts/session-pruning).

**Context feels stale after compaction?** Use `/compact Focus on <topic>` to
guide the summary, or enable the [memory flush](/concepts/memory) so notes
survive.

**Need a clean slate?** `/new` starts a fresh session without compacting.

For advanced configuration (reserve tokens, identifier preservation, custom
context engines, OpenAI server-side compaction), see the
[Session Management Deep Dive](/reference/session-management-compaction).

## Related

- [Session](/concepts/session) — session management and lifecycle
- [Session Pruning](/concepts/session-pruning) — trimming tool results
- [Context](/concepts/context) — how context is built for agent turns
- [Hooks](/automation/hooks) — compaction lifecycle hooks (before_compaction, after_compaction)
