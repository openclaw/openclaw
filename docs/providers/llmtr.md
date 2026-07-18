---
summary: "Use LLMTR's Turkey-hosted OpenAI-compatible AI gateway with OpenClaw"
read_when:
  - You want to run OpenClaw against Turkish-hosted models
  - You need the LLMTR provider id, key, or endpoint
title: "LLMTR"
---

LLMTR is an AI gateway hosted in Turkey that exposes Turkish-hosted models
alongside global vendor models behind one OpenAI-compatible API and a single
API key. It ships as a bundled OpenClaw provider (no separate plugin install),
so credentials go through the normal model auth flow and model refs look like
`llmtr/anthropic/claude-sonnet-5`.

Turkey-hosted routes are named `llmtr/<name>` upstream, so their refs collapse
to a single prefix: the Trendyol model is `llmtr/trendyol-7b`, not
`llmtr/llmtr/trendyol-7b`.

## Setup

Create an API key at [llmtr.com](https://llmtr.com), then run:

```bash
openclaw onboard --auth-choice llmtr-api-key
```

Or set:

```bash
export LLMTR_API_KEY="<your-llmtr-api-key>" # pragma: allowlist secret
```

## Defaults

| Setting       | Value                             |
| ------------- | --------------------------------- |
| Provider id   | `llmtr`                           |
| Base URL      | `https://llmtr.com/v1`            |
| Env var       | `LLMTR_API_KEY`                   |
| Default model | `llmtr/anthropic/claude-sonnet-5` |

## Bundled model catalog

The bundled catalog is what agent runs resolve against, so a model must be
listed here (or added via config, below) to be usable with `--model`.

```bash
openclaw models list --provider llmtr
```

Turkey-hosted:

- `llmtr/gemma-4`
- `llmtr/qwen3-6-35b`
- `llmtr/qwen3-5-4b`
- `llmtr/trendyol-7b`
- `llmtr/magibu-11b-v8`
- `llmtr/medgemma-4b`
- `llmtr/sincap`

Chinese-origin (GLM, Qwen, DeepSeek, Kimi, MiniMax, Step, MiMo, KAT):

- `llmtr/zai/glm-5.2`, `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`,
  `glm-4.6`, `glm-4.5-air`, `glm-4.6v` (vision)
- `llmtr/qwen/qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`, `qwen3.5-plus`,
  `qwen3-coder-plus`
- `llmtr/deepseek/deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-reasoner`,
  `deepseek-chat`
- `llmtr/moonshot/kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`
- `llmtr/minimax/minimax-m3`, `minimax-m2.7`
- `llmtr/stepfun/step-3.7-flash`, `llmtr/mimo/mimo-v2.5-pro`,
  `llmtr/kwaikat/kat-coder-pro-v2.5`

Western:

- `llmtr/anthropic/claude-sonnet-5`, `claude-opus-4.8`, `claude-haiku-4.5`
- `llmtr/openai/gpt-5.4`, `gpt-5.4-mini`
- `llmtr/google/gemini-3.1-pro-preview`, `gemini-3.5-flash`
- `llmtr/mistral/mistral-large-latest`

## Using a model that is not bundled

LLMTR serves far more chat models than the bundled catalog lists. Add any of
them under `models.providers.llmtr.models`:

```json
{
  "models": {
    "providers": {
      "llmtr": {
        "models": [{ "id": "perplexity/sonar-pro", "contextWindow": 131072, "maxTokens": 32768 }]
      }
    }
  }
}
```

Only routes that LLMTR exposes on `/v1/chat/completions` work. Models it
serves solely through `/v1/responses` (OpenAI `gpt-5.5`+ and Codex, Grok 4.x,
Qwen VL) are unusable here, as are embedding, image, video, and audio routes.
Check `supported_operations` in `curl https://llmtr.com/v1/models` first.

LLMTR's API publishes no context windows or per-model pricing, so the values
in the bundled catalog are deliberately conservative — under-declaring a
window truncates history early rather than failing the request. Raise it in
config if you need more, and see [llmtr.com/pricing](https://llmtr.com/pricing)
for cost.

## When to choose LLMTR

- Turkish data residency, or Turkish-language models such as Trendyol and
  Sincap.
- One account and key covering both Turkish-hosted and global vendor models.
- A gateway fallback beside OpenRouter or direct vendor APIs.

Choose a direct vendor provider when you need vendor-native request
parameters, prompt caching, or support contracts — LLMTR adds a platform
margin on credit purchases and normalizes requests through its own gateway.

## Troubleshooting

- `401`/`403`: verify the key in the LLMTR dashboard and re-run
  `openclaw onboard --auth-choice llmtr-api-key` if the stored profile is
  stale.
- Unknown model errors: use the exact `llmtr/<route-id>` returned by
  `openclaw models list --provider llmtr`.
- A model appears on llmtr.com but not in OpenClaw: it is most likely a
  `/v1/responses`-only or non-chat route. Confirm with
  `curl https://llmtr.com/v1/models` and check `supported_operations`.
- `502` or idle timeouts on Turkey-hosted `llmtr/*` routes: these are hosted
  on smaller capacity and can be temporarily unavailable. Retry, or fall back
  to a global route; the same key serves both.

## Related

- [Model providers](/concepts/model-providers)
- [Provider directory](/providers/index)
