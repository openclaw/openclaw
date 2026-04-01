---
summary: "Use Nexos AI gateway models in OpenClaw"
read_when:
  - You want to use Nexos AI as a model provider
  - You need Nexos AI setup guidance
title: "Nexos AI"
---

# Nexos AI

Nexos AI is a unified AI gateway that provides OpenAI-compatible access to models from multiple providers (Anthropic, OpenAI, Google, xAI, Mistral, and more) through a single API endpoint. It includes workspace management, team-based API key governance, budgeting, model fallback configuration, and self-hosted open-source models.

## Why Nexos AI in OpenClaw

- **Multi-provider gateway** — access Claude, GPT, Gemini, Grok, Devstral, and 60+ other models through one API key.
- **OpenAI-compatible** `/v1` endpoints — works with standard tooling.
- **Team governance** — manage model access, API keys, and usage at the team level.
- **Budgeting** — set spending limits per team, user, or API key to control AI costs.
- **Model fallbacks** — configure automatic fallback chains when a model is unavailable.
- **Self-hosted open-source models** — Nexos hosts popular open-source models (Gemma 3, Llama 4 Scout, GLM 5, and others) on their own infrastructure, no GPU management required.
- **Dynamic model discovery** — OpenClaw automatically fetches the latest model catalog from the Nexos API at startup, so new models appear without config changes.

## Setup

### 1. Get API Key

1. Sign up at [nexos.ai](https://nexos.ai)
2. Generate a **Team API Key** (Management > Teams > Select team > Generate API Key) or a **User API Key** (profile menu > User profile > Generate API Key)
3. Save your API key immediately — it cannot be retrieved later

### 2. Configure OpenClaw

**Option A: Interactive Setup (Recommended)**

```bash
openclaw onboard --auth-choice nexos-api-key
```

This will:

1. Prompt for your API key (or use existing `NEXOS_API_KEY`)
2. Show available Nexos models
3. Let you pick your default model
4. Configure the provider automatically

**Option B: Environment Variable**

```bash
export NEXOS_API_KEY="your-api-key-here"
```

**Option C: Non-interactive**

```bash
openclaw onboard --non-interactive \
  --auth-choice nexos-api-key \
  --nexos-api-key "your-api-key-here"
```

### 3. Verify Setup

```bash
openclaw agent --model "nexos/Claude Opus 4.6" --message "Hello, are you working?"
```

## Model Selection

After setup, pick a model based on your needs:

- **Default model**: `nexos/Claude Opus 4.6` — strongest reasoning model available.
- **Fast option**: `nexos/Gemini 3 Flash Preview` — good balance of speed and capability.
- **OpenAI**: `nexos/GPT 5.2` or `nexos/GPT 4.1` for GPT-family models.
- **Coding**: `nexos/Devstral 2` — Mistral coding-focused model.

Change your default model anytime:

```bash
openclaw models set "nexos/Claude Opus 4.6"
openclaw models set "nexos/Gemini 3 Flash Preview"
```

List all available models:

```bash
openclaw models list | grep nexos
```

## Available Models

These are the default models in the static catalog. With dynamic discovery enabled (automatic when an API key is configured), OpenClaw fetches the full list of 60+ models from the Nexos API at startup.

| Model ID                 | Name                   | Context | Features          |
| ------------------------ | ---------------------- | ------- | ----------------- |
| `Claude Opus 4.6`        | Claude Opus 4.6        | 200k    | Reasoning, vision |
| `Claude Opus 4.5`        | Claude Opus 4.5        | 200k    | Reasoning, vision |
| `Claude Sonnet 4.6`      | Claude Sonnet 4.6      | 200k    | Reasoning, vision |
| `Claude Sonnet 4.5`      | Claude Sonnet 4.5      | 200k    | Reasoning, vision |
| `Claude Haiku 4.5`       | Claude Haiku 4.5       | 200k    | Vision            |
| `GPT 5.2`                | GPT 5.2                | 128k    | Reasoning         |
| `GPT 5`                  | GPT 5                  | 128k    | Reasoning         |
| `GPT 4.1`                | GPT 4.1                | 1M      | General           |
| `Gemini 3 Flash Preview` | Gemini 3 Flash Preview | 1M      | Reasoning, vision |
| `Gemini 2.5 Pro`         | Gemini 2.5 Pro         | 1M      | Reasoning, vision |
| `Grok 4 Fast`            | Grok 4 Fast            | 128k    | Reasoning         |
| `Devstral 2`             | Devstral 2             | 128k    | Coding            |

<Note>
OpenClaw automatically discovers all available Nexos models at startup using `GET /v1/models`. The table above is the static fallback catalog. Run `openclaw models list` to see the full live list, which includes additional models like Kimi K2.5, Mistral Large, GPT 5.1 Codex, and self-hosted open-source models (Gemma 3, Llama 4 Scout, GLM 5).
</Note>

## Streaming and Tool Support

| Feature              | Support                                    |
| -------------------- | ------------------------------------------ |
| **Streaming**        | Supported on all models                    |
| **Function calling** | Supported (OpenAI-compatible tool calling) |
| **Vision/Images**    | Supported on models with vision capability |

## Usage Examples

```bash
# Use Claude Opus 4.6
openclaw agent --model "nexos/Claude Opus 4.6" --message "Summarize this task"

# Use Gemini 3 Flash Preview for fast responses
openclaw agent --model "nexos/Gemini 3 Flash Preview" --message "Quick health check"

# Use GPT 5.2
openclaw agent --model "nexos/GPT 5.2" --message "Review this code"
```

## Troubleshooting

### API key not recognized

```bash
echo $NEXOS_API_KEY
openclaw models list | grep nexos
```

Ensure the key was saved correctly during generation. Nexos API keys cannot be retrieved after creation — generate a new one if lost.

### Model not available

The available model catalog depends on your team configuration. Check with your team admin if a model is missing.

### Connection issues

Nexos API is at `https://api.nexos.ai/v1`. Ensure your network allows HTTPS connections to this endpoint.

## Config File Example

```json5
{
  env: { NEXOS_API_KEY: "your-api-key" },
  agents: { defaults: { model: { primary: "nexos/Claude Opus 4.6" } } },
  models: {
    mode: "merge",
    providers: {
      nexos: {
        baseUrl: "https://api.nexos.ai/v1",
        apiKey: "${NEXOS_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "Claude Opus 4.6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 128000,
          },
        ],
      },
    },
  },
}
```

## Links

- [Nexos AI](https://nexos.ai)
- [API Documentation](https://docs.nexos.ai/gateway-api)
- [Workspace Documentation](https://docs.nexos.ai/workspace)
