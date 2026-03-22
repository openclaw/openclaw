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

Use the `agents.defaults.compaction` setting in your `openclaw.json` to configure compaction behavior, including:

- `triggerTokens`: model-aware full-context threshold for auto-compaction after a successful turn
- `targetTokens`: strict-best-effort full-context target after compaction
- legacy Pi-native `reserveTokens` / `keepRecentTokens` overrides
- safeguard behavior and compaction-only model selection

Compaction summarization preserves opaque identifiers by default (`identifierPolicy: "strict"`). You can override this with `identifierPolicy: "off"` or provide custom text with `identifierPolicy: "custom"` and `identifierInstructions`.

You can optionally specify a different model for compaction summarization via `agents.defaults.compaction.model`. This is useful when your primary model is a local or small model and you want compaction summaries produced by a more capable model. The override accepts any `provider/model-id` string:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "openrouter/anthropic/claude-sonnet-4-5"
      }
    }
  }
}
```

This also works with local models, for example a second Ollama model dedicated to summarization or a fine-tuned compaction specialist:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "ollama/llama3.1:8b"
      }
    }
  }
}
```

When unset, compaction uses the agent's primary model.

## Auto-compaction (default on)

Pi auto-compaction triggers in two cases:

- Overflow recovery: the model returns a context overflow error, so Pi compacts and retries.
- Threshold maintenance: after a successful turn, when `contextTokens > contextWindow - reserveTokens`.

`triggerTokens` is an OpenClaw convenience layer on top of that Pi behavior. OpenClaw resolves the active model window, derives `reserveTokens = contextWindow - triggerTokens`, then still applies `reserveTokensFloor`.

`targetTokens` is separate from the trigger. It is a strict-best-effort post-compaction budget that can recompute the cut point and retry compaction to reduce the resulting full context size.

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

## OpenAI server-side compaction

OpenClaw also supports OpenAI Responses server-side compaction hints for
compatible direct OpenAI models. This is separate from local OpenClaw
compaction and can run alongside it.

- Local compaction: OpenClaw summarizes and persists into session JSONL.
- Server-side compaction: OpenAI compacts context on the provider side when
  `store` + `context_management` are enabled.

See [OpenAI provider](/providers/openai) for model params and overrides.

## Tips

- Use `/compact` when sessions feel stale or context is bloated.
- Large tool outputs are already truncated; pruning can further reduce tool-result buildup.
- If you need a fresh slate, `/new` or `/reset` starts a new session id.
