---
title: "DInference"
summary: "DInference setup (auth + model selection)"
read_when:
  - You want to use DInference with OpenClaw
  - You need the API key env var or CLI auth choice
---

# DInference

[DInference](https://dinference.com) provides access to GLM models (GLM-5, GLM-4.7, and GPT-OSS-120B) through an OpenAI-compatible API with extended context windows and advanced features.

- Provider: `dinference`
- Auth: `DINFERENCE_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice dinference-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "dinference/glm-5" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice dinference-api-key \
  --dinference-api-key "$DINFERENCE_API_KEY"
```

This will set `dinference/glm-5` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `DINFERENCE_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Available models

DInference provides access to GLM models with extended context windows:

- **GLM 5** - Default model with 200K context window, supports tools, structured outputs, JSON mode, and reasoning
- **GLM 4.7** - 200K context window, supports tools, structured outputs, JSON mode, and reasoning
- **GPT-OSS 120B** - 131K context window, supports tools, structured outputs, JSON mode, and reasoning

All models support standard chat completions and are OpenAI API compatible.

## Features

All DInference models support:

- **Tools** - Function calling
- **Structured outputs** - JSON schema validation
- **JSON mode** - Force JSON responses
- **Reasoning** - Advanced reasoning capabilities
- **Streaming** - Real-time token streaming

## Pricing

Pricing information is available on the [DInference website](https://dinference.com).

## Getting an API key

1. Visit [DInference](https://dinference.com)
2. Sign up for an account
3. Navigate to API keys section
4. Generate an API key
5. Use the key with OpenClaw

## Troubleshooting

### Authentication error

If you see authentication errors, verify:

- `DINFERENCE_API_KEY` environment variable is set
- The API key is valid and active
- The API key has sufficient permissions

### Model not found

If you see "model not found" errors, verify:

- You are using the correct model ID (`glm-5`, `glm-4.7`, or `gpt-oss-120b`)
- The model is available in your DInference account

### API connectivity issues

If you experience connectivity issues:

- Check your internet connection
- Verify the API endpoint `https://api.dinference.com/v1` is accessible
- Check for any rate limits or quota restrictions on your account
