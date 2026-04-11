---
title: "Arcee AI"
summary: "Arcee AI setup (auth + model selection)"
read_when:
  - You want to use Arcee AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Arcee AI

[Arcee AI](https://arcee.ai) provides access to the Trinity family of mixture-of-experts models through an OpenAI-compatible API. All Trinity models are Apache 2.0 licensed.

Arcee AI models can be accessed directly via the Arcee platform or through [OpenRouter](/providers/openrouter).

- Provider: `arcee`
- Auth: `ARCEEAI_API_KEY` (direct) or `OPENROUTER_API_KEY` (via OpenRouter)
- API: OpenAI-compatible
- Base URL: `https://api.arcee.ai/api/v1` (direct) or `https://openrouter.ai/api/v1` (OpenRouter)

## Quick start

1. Get an API key from [Arcee AI](https://chat.arcee.ai/) or [OpenRouter](https://openrouter.ai/keys).

2. Set the API key (recommended: store it for the Gateway):

```bash
# Direct (Arcee platform)
openclaw onboard --auth-choice arceeai-api-key

# Via OpenRouter
openclaw onboard --auth-choice arceeai-openrouter
```

3. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "arcee/trinity-large-thinking" },
    },
  },
}
```

## Non-interactive example

```bash
# Direct (Arcee platform)
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice arceeai-api-key \
  --arceeai-api-key "$ARCEEAI_API_KEY"

# Via OpenRouter
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice arceeai-openrouter \
  --openrouter-api-key "$OPENROUTER_API_KEY"
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `ARCEEAI_API_KEY`
(or `OPENROUTER_API_KEY`) is available to that process (for example, in
`~/.openclaw/.env` or via `env.shellEnv`).

## Built-in catalog

OpenClaw currently ships this bundled Arcee catalog:

| Model ref                      | Name                   | Input | Context | Cost (in/out per 1M) | Notes                                     |
| ------------------------------ | ---------------------- | ----- | ------- | -------------------- | ----------------------------------------- |
| `arcee/trinity-large-thinking` | Trinity Large Thinking | text  | 256K    | $0.25 / $0.90        | Default model; reasoning enabled          |
| `arcee/trinity-large-preview`  | Trinity Large Preview  | text  | 128K    | $0.25 / $1.00        | General-purpose; 400B params, 13B active  |
| `arcee/trinity-mini`           | Trinity Mini 26B       | text  | 128K    | $0.045 / $0.15       | Fast and cost-efficient; function calling |

The same model refs work for both direct and OpenRouter setups (for example `arcee/trinity-large-thinking`).

The onboarding preset sets `arcee/trinity-large-thinking` as the default model.

## Supported features

- Streaming
- Tool use / function calling
- Structured output (JSON mode and JSON schema)
- Extended thinking (Trinity Large Thinking)
