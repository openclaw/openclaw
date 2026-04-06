---
summary: "DeepSeek setup (auth + model selection)"
read_when:
  - You want to use DeepSeek with OpenClaw
  - You need the API key env var or CLI auth choice
---

# DeepSeek

[DeepSeek](https://www.deepseek.com) provides powerful AI models with an OpenAI-compatible API.

- Provider: `deepseek`
- Auth: `DEEPSEEK_API_KEY`
- API: OpenAI-compatible
- Base URL: `https://api.deepseek.com`

## Quick start

Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice deepseek-api-key
```

This will prompt for your API key and set `deepseek/deepseek-chat` as the default model.

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice deepseek-api-key \
  --deepseek-api-key "$DEEPSEEK_API_KEY" \
  --skip-health \
  --accept-risk
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `DEEPSEEK_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Built-in catalog

| Model ref                    | Name              | Input | Context | Max output | Notes                                             |
| ---------------------------- | ----------------- | ----- | ------- | ---------- | ------------------------------------------------- |
| `deepseek/deepseek-chat`     | DeepSeek Chat     | text  | 131,072 | 8,192      | Default model; DeepSeek V3.2 non-thinking surface |
| `deepseek/deepseek-reasoner` | DeepSeek Reasoner | text  | 131,072 | 65,536     | Reasoning-enabled V3.2 surface                    |

Both bundled models currently advertise streaming usage compatibility in source.

Get your API key at [platform.deepseek.com](https://platform.deepseek.com/api_keys).
