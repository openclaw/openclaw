---
summary: "Chuizi.AI setup (auth + model selection)"
read_when:
  - You want to use Chuizi.AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Chuizi.AI

[Chuizi.AI](https://chuizi.ai) is a unified AI API gateway that provides access to 100+ models across 16 providers through a single OpenAI-compatible endpoint.

- Provider: `chuizi`
- Auth: `CHUIZI_API_KEY`
- API: OpenAI-compatible

## Quick start

Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice chuizi-api-key
```

This will prompt for your API key and set `chuizi/anthropic/claude-sonnet-4-6` as the default model.

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice chuizi-api-key \
  --chuizi-api-key "$CHUIZI_API_KEY" \
  --skip-health \
  --accept-risk
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `CHUIZI_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Available models

| Model ID                      | Name              | Type      | Context |
| ----------------------------- | ----------------- | --------- | ------- |
| `anthropic/claude-sonnet-4-6` | Claude Sonnet 4.6 | General   | 200K    |
| `anthropic/claude-opus-4-6`   | Claude Opus 4.6   | Reasoning | 200K    |
| `anthropic/claude-haiku-4-5`  | Claude Haiku 4.5  | General   | 200K    |
| `openai/gpt-4.1`              | GPT-4.1           | General   | 200K    |
| `openai/o4-mini`              | o4-mini           | Reasoning | 200K    |
| `google/gemini-2.5-pro`       | Gemini 2.5 Pro    | Reasoning | 1M      |
| `deepseek/deepseek-chat`      | DeepSeek V3.2     | General   | 128K    |
| `deepseek/deepseek-r1`        | DeepSeek R1       | Reasoning | 128K    |

Models use `provider/model` naming. Additional models (Qwen, Llama, Mistral, etc.) are accessible by passing any supported model ID.

Get your API key at [app.chuizi.ai](https://app.chuizi.ai/login).
