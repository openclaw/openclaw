---
summary: "Context window + compaction: how OpenClaw keeps sessions under model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
---

# Context Window & Compaction

Every model has a **context window** (max tokens it can see). Long-running chats accumulate messages and tool results; once the window is tight, OpenClaw **compacts** older history to stay within limits.

## What compaction is

Compaction **summarizes older conversation** into a compact summary entry and keeps recent messages intact. The summary is stored in the session history, so future requests use:

- The compaction summary
- Recent messages after the compaction point

Compaction **persists** in the session’s JSONL history.

## Configuration

Use `agents.defaults.compaction` in your config to tune compaction:

```yaml
agents:
  defaults:
    compaction:
      mode: safeguard          # "default" or "safeguard"
      reserveTokensFloor: 8000 # min tokens reserved for reply
      maxHistoryShare: 0.7     # max share of context for history
      memoryFlush:
        enabled: true          # flush memories before compacting
        softThresholdTokens: 50000
```

Related settings:

| Key | Default | Description |
|-----|---------|-------------|
| `agents.defaults.contextTokens` | *(from model)* | Cap the context window (useful for small models) |
| `agents.defaults.bootstrapMaxChars` | `20000` | Max chars per workspace file injected into system prompt |
| `agents.defaults.bootstrapTotalMaxChars` | `150000` | Total char budget for all injected workspace files |

> **Note:** There is no `autoCompact` config key. Auto-compaction is always enabled and triggers automatically when the context window is tight. Use `agents.defaults.compaction` to tune its behavior.

## Auto-compaction (default on)

When a session nears or exceeds the model’s context window, OpenClaw triggers auto-compaction and may retry the original request using the compacted context.

You’ll see:

- `🧹 Auto-compaction complete` in verbose mode
- `/status` showing `🧹 Compactions: <count>`

Before compaction, OpenClaw can run a **silent memory flush** turn to store
durable notes to disk. See [Memory](/concepts/memory) for details and config.

## Manual compaction

Use `/compact` (optionally with instructions) to force a compaction pass:

```
/compact Focus on decisions and open questions
```

## Context window source

Context window is model-specific. OpenClaw uses the model definition from the configured provider catalog to determine limits.

## Compaction vs pruning

- **Compaction**: summarises and **persists** in JSONL.
- **Session pruning**: trims old **tool results** only, **in-memory**, per request.

See [/concepts/session-pruning](/concepts/session-pruning) for pruning details.

## Troubleshooting context overflow

If you see "Context overflow: prompt too large for the model" even on fresh sessions:

1. **Check your workspace files.** Large `AGENTS.md`, `SOUL.md`, `USER.md`, etc. are injected into every prompt. Use `/context` to see sizes. Lower `agents.defaults.bootstrapMaxChars` to reduce per-file injection.

2. **Check the model's context window.** Use `/status` to see your model. Some models have small windows (8k–32k). The error message includes the resolved context window and its source.

3. **Simplify workspace files.** Remove files you don't need, or reduce their size. The system prompt + workspace files + tools can consume significant tokens before any conversation starts.

4. **Cap the context window.** Set `agents.defaults.contextTokens` to match your model if auto-detection is wrong.

5. **Switch models.** Models with larger context windows (100k+) are less likely to overflow.

## Tips

- Use `/compact` when sessions feel stale or context is bloated.
- Large tool outputs are already truncated; pruning can further reduce tool-result buildup.
- If you need a fresh slate, `/new` or `/reset` starts a new session id.
