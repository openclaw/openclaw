---
summary: "Server-rendered status footer and context-usage warnings"
read_when:
  - Configuring an outbound status footer for chat channels
  - Wanting context-threshold warnings prepended to replies
  - Diagnosing fabricated footer numbers from a model
title: "Outbound footer and context warnings"
---

OpenClaw renders the status footer on outbound chat messages from live runtime
state. The model never authors the digits, so a fabricated footer is impossible
by construction.

## Why server-rendered

Asking a model to write its own status footer (for example,
`📚 X% (Xk/200k) · 🧹 N compactions · 🧠 model`) is structurally unreliable.
Even with explicit prompt rules, the model can write whatever number it last
saw or estimated. Logged production regressions have shown a model claiming
`5% (10k/200k)` while actual context was `134% (268k/200k)`.

The runtime owns the truth (context tokens, compaction count, model alias).
The runtime should write the footer. This page describes how to enable that.

## Stripping fabricated footers

The outbound pipeline always strips any model-written footer matching the
canonical pattern, even when the renderer is disabled. There is no opt-out:
fabricated runtime telemetry is never user-facing.

The stripper matches:

```
📚 <pct>% (<used>k/<limit>k) · 🧹 <n> compactions · 🧠 <model>
```

Bullet variants (`•`) and decimal token counts are also matched.

## Enabling the renderer

Add to `openclaw.json`:

```json
{
  "messages": {
    "outboundFooter": {
      "enabled": true,
      "template": "📚 {context_pct}% ({context_tokens}/{context_limit}) · 🧹 {compactions} compactions · 🧠 {model_alias}"
    }
  }
}
```

Supported placeholders:

- `{context_pct}` integer percent of the context window in use.
- `{context_tokens}` current usage, formatted as `Nk`.
- `{context_limit}` configured context limit, formatted as `Nk`.
- `{compactions}` integer compaction count for this session.
- `{model_alias}` active model identifier, for example `anthropic/claude-opus-4-7`.

Unknown placeholders are left as the literal `{name}` form so config typos stay
visible.

When values are unavailable (for example a brand-new session before the first
turn finishes), the footer still renders with `?` in place of missing fields.

## Context threshold warnings

A separate one-shot warning can be prepended when context usage crosses a
configured threshold:

```json
{
  "messages": {
    "contextWarning": {
      "enabled": true,
      "thresholds": [70, 85, 95]
    }
  }
}
```

When usage crosses the highest unwarned threshold, OpenClaw prepends a single
line to the next outbound message:

```
⚠️ Context 90% - consider /new
```

Each threshold fires once per session. Threshold state is persisted on the
session entry (`contextWarningThresholdsTriggered`), so warnings do not spam
across multiple turns.

## Where the values come from

Both features pull from the same source as `session_status`:

- `contextTokens` from the session entry written by the agent runtime each
  turn.
- `contextLimit` from `agents.defaults.contextTokens` when set, otherwise the
  hook renders `?` for the limit and skips the warning.
- `compactionCount` from the session entry compaction tracker.
- `model_alias` from `<provider>/<model>` on the session entry, falling back to
  `agents.defaults.model.primary`.

If session telemetry cannot be loaded, the hook is a no-op for that send and
delivery proceeds with the original (still fabricated-footer-stripped) text.
