---
summary: "Novita AI setup (auth + model selection)"
read_when:
  - You want to use Novita AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Novita AI

[Novita AI](https://novita.ai) is an AI model aggregator offering 200+ models from DeepSeek, Qwen, MiniMax, Kimi, GLM, Llama, and more through a single API key.

- Provider: `novita`
- Auth: `NOVITA_API_KEY`
- API: OpenAI-compatible

## Quick start

Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice novita-api-key
```

This will prompt for your API key and set `novita/moonshotai/kimi-k2.5` as the default model.

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice novita-api-key \
  --novita-api-key "$NOVITA_API_KEY" \
  --skip-health \
  --accept-risk
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `NOVITA_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Available models

The model catalog is fetched dynamically from the Novita AI API. Over 90 LLMs
are available, including:

| Model ID                    | Name          | Type      | Context |
| --------------------------- | ------------- | --------- | ------- |
| `moonshotai/kimi-k2.5`      | Kimi K2.5     | Reasoning | 256K    |
| `minimax/minimax-m2.7`      | MiniMax M2.7  | Reasoning | 200K    |
| `zai-org/glm-5`             | GLM-5         | Reasoning | 200K    |
| `deepseek/deepseek-v3.2`    | DeepSeek V3.2 | General   | 160K    |
| `deepseek/deepseek-r1-0528` | DeepSeek R1   | Reasoning | 160K    |
| `qwen/qwen3.5-397b-a17b`    | Qwen 3.5 397B | General   | 256K    |

To see all available models:

```bash
openclaw models list --all --provider novita
```

## Dynamic model resolution

Any model available on Novita AI can be used directly — you are not limited
to the seed catalog. If a model is not yet cached locally, it will be fetched
from the API on first use.

```bash
openclaw models set novita/deepseek/deepseek-v3.2
```

## Pricing

Pricing is fetched in real time from the Novita AI API. Visit
[novita.ai/pricing](https://novita.ai/pricing) for the latest rates.

Get your API key at [novita.ai/settings/key-management](https://novita.ai/settings/key-management).
