---
summary: "How much conversation the sub-agent sees, how eager it is about returning memory, and how its model is resolved."
read_when:
  - You are tuning recall quality against latency
  - You want a dedicated fast recall model
title: "Query modes, prompts, and models"
---

## Query modes

`config.queryMode` controls how much conversation the blocking sub-agent
sees. Pick the smallest mode that still answers follow-ups well; grow
`timeoutMs` as context size grows, from `message` to `recent` to `full`.

All modes share a 4,000-character budget (UTF-16 code units) for the assembled conversation
context. The current message takes priority: when it fits, it is kept intact,
and the remaining space holds the newest eligible history. Older history is
omitted first, with an explicit marker when only part of the history fits.
If the current message alone exceeds the
budget, its beginning and end are kept with a middle-omission marker. This only
limits the recall sub-agent; the answering model still receives the original
request.

<Tabs>
  <Tab title="message">
    Only the latest user message is sent.

    ```text
    Latest user message only
    ```

    Use when you want the fastest behavior, the strongest bias toward stable
    preference recall, and follow-up turns do not need conversational
    context. Start around `3000`-`5000` ms for `config.timeoutMs`.

  </Tab>

  <Tab title="recent">
    The latest user message plus a small recent conversational tail.

    ```text
    Recent conversation tail:
    user: ...
    assistant: ...
    user: ...

    Latest user message:
    ...
    ```

    Use for a balance of speed and conversational grounding, when follow-up
    questions often depend on the last few turns. Start around `15000` ms.

  </Tab>

  <Tab title="full">
    All available conversation history is eligible within the shared budget.

    ```text
    Full conversation context:
    user: ...
    assistant: ...
    user: ...
    ...
    ```

    Use when recall needs more history than the recent-mode turn limits.
    The newest history that fits is retained. Start around `15000` ms or higher
    depending on context size.

  </Tab>
</Tabs>

## Prompt styles

`config.promptStyle` controls how eager or strict the sub-agent is about
returning memory:

| Style             | Behavior                                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| `balanced`        | General-purpose default for `recent` mode                                  |
| `strict`          | Least eager; minimal bleed from nearby context                             |
| `contextual`      | Most continuity-friendly; conversation history matters more                |
| `recall-heavy`    | Surfaces memory on softer but still plausible matches                      |
| `precision-heavy` | Aggressively prefers `NONE` unless the match is obvious                    |
| `preference-only` | Optimized for favorites, habits, routines, taste, recurring personal facts |

Default mapping when `config.promptStyle` is unset:

```text
message -> strict
recent -> balanced
full -> contextual
```

An explicit `config.promptStyle` always overrides the mapping.

## Model fallback policy

If `config.model` is unset, active memory resolves a model in this order:

```text
explicit plugin model (config.model)
-> current session model
-> agent primary model
-> optional configured fallback model (config.modelFallback)
```

```json5
modelFallback: "google/gemini-3-flash"
```

If nothing in that chain resolves, active memory skips recall for the turn.
`config.modelFallbackPolicy` is a compatibility field kept for older configs,
deprecated in v2026.4.12; it no longer changes runtime behavior — `modelFallback` is
strictly the last resort in the chain above, not a runtime failover that
swaps in another model when the resolved one errors.

### Speed recommendations

Leaving `config.model` unset (inherit the session model) is the safest
default: it follows your existing provider, auth, and model preferences. For
lower latency, use a dedicated fast model instead — recall quality matters,
but latency matters more here than on the main answer path, and the tool
surface is narrow (only memory recall tools).

Good fast-model options:

- `cerebras/gpt-oss-120b`, a dedicated low-latency recall model
- `google/gemini-3-flash`, a low-latency fallback without changing your primary chat model
- your normal session model, by leaving `config.model` unset

#### Cerebras setup

```json5
{
  models: {
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [{ id: "gpt-oss-120b", name: "GPT OSS 120B (Cerebras)" }],
      },
    },
  },
  plugins: {
    entries: {
      "active-memory": {
        enabled: true,
        config: { model: "cerebras/gpt-oss-120b" },
      },
    },
  },
}
```

Confirm the Cerebras API key has `chat/completions` access for the chosen
model — `/v1/models` visibility alone does not guarantee it.
