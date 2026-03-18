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

Use the `agents.defaults.compaction` setting in your `openclaw.json` to configure compaction behavior (mode, target tokens, etc.).
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

## Morph fast compaction

Morph provides a dedicated compaction API that compresses conversation context at 25k+ tokens per second with sub-300ms latency. It is available as a bundled plugin. When enabled, OpenClaw uses Morph for compaction and automatically falls back to LLM summarization if the Morph API is unavailable.

To enable, set the compaction provider and enable the Morph plugin:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "provider": "morph"
      }
    }
  },
  "plugins": {
    "entries": {
      "morph": {
        "enabled": true,
        "config": {
          "apiKey": "morph-..."
        }
      }
    }
  }
}
```

You can also set the key via the `MORPH_API_KEY` environment variable instead of storing it in plugin config.

The `compressionRatio` plugin config (0.05-1.0, default 0.3) controls how aggressively context is compressed. Lower values produce shorter summaries.

Run `openclaw morph status` to check your Morph integration status.

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

## OpenAI server-side compaction

OpenClaw also supports OpenAI Responses server-side compaction hints for
compatible direct OpenAI models. This is separate from local OpenClaw
compaction and can run alongside it.

- Local compaction: OpenClaw summarizes and persists into session JSONL.
- Server-side compaction: OpenAI compacts context on the provider side when
  `store` + `context_management` are enabled.

See [OpenAI provider](/providers/openai) for model params and overrides.

## Custom context engines

Compaction behavior is owned by the active
[context engine](/concepts/context-engine). The legacy engine uses the built-in
summarization described above. Plugin engines (selected via
`plugins.slots.contextEngine`) can implement any compaction strategy — DAG
summaries, vector retrieval, incremental condensation, etc.

When a plugin engine sets `ownsCompaction: true`, OpenClaw delegates all
compaction decisions to the engine and does not run built-in auto-compaction.

When `ownsCompaction` is `false` or unset, OpenClaw may still use Pi's
built-in in-attempt auto-compaction, but the active engine's `compact()` method
still handles `/compact` and overflow recovery. There is no automatic fallback
to the legacy engine's compaction path.

If you are building a non-owning context engine, implement `compact()` by
calling `delegateCompactionToRuntime(...)` from `openclaw/plugin-sdk/core`.

## Tips

- Use `/compact` when sessions feel stale or context is bloated.
- Large tool outputs are already truncated; pruning can further reduce tool-result buildup.
- If you need a fresh slate, `/new` or `/reset` starts a new session id.
