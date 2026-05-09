---
summary: "Use Novita AI's OpenAI-compatible LLM API in OpenClaw"
read_when:
  - You want to use Novita AI models with OpenClaw
  - You need NOVITA_API_KEY setup or model refs
title: "Novita AI"
---

Novita AI provides OpenAI-compatible chat completions for hosted models such as
DeepSeek, Kimi, GLM, and MiniMax. OpenClaw uses the standard
`openai-completions` provider path with the Novita base URL.

## Setup

1. Create a Novita AI API key at [Novita key management](https://novita.ai/settings/key-management).
2. Run onboarding:

```bash
openclaw onboard --auth-choice novita-api-key
```

Or set the environment variable on the Gateway host:

```bash
export NOVITA_API_KEY="<your-novita-api-key>" # pragma: allowlist secret
```

## Default model

The bundled plugin defaults to:

```json5
{
  agents: {
    defaults: {
      model: { primary: "novita/moonshotai/kimi-k2.6" },
    },
  },
}
```

## Curated static catalog

OpenClaw ships a small static fallback catalog so model setup and pickers work
even before live discovery completes:

| Model                | Ref                                 |
| -------------------- | ----------------------------------- |
| DeepSeek V4 Pro      | `novita/deepseek/deepseek-v4-pro`   |
| DeepSeek V4 Flash    | `novita/deepseek/deepseek-v4-flash` |
| Kimi K2.6            | `novita/moonshotai/kimi-k2.6`       |
| GLM-5.1              | `novita/zai-org/glm-5.1`            |
| Xiaomi MiMo V2.5 Pro | `novita/xiaomimimo/mimo-v2.5-pro`   |
| MiniMax M2.7         | `novita/minimax/minimax-m2.7`       |

When `NOVITA_API_KEY` is available, OpenClaw refreshes the model list from
`https://api.novita.ai/openai/v1/models` and includes additional Novita models
returned by your account.

## Notes

- Provider id: `novita`
- Auth: `NOVITA_API_KEY`
- Base URL: `https://api.novita.ai/openai/v1`
- API: OpenAI-compatible chat completions (`openai-completions`)
- Provider-specific request behavior follows the generic OpenAI-compatible proxy path, so native OpenAI-only fields such as Responses `store`, prompt-cache hints, and OpenAI service tiers are not applied.

## Related

- [Model providers](/concepts/model-providers)
- [Provider directory](/providers/index)
