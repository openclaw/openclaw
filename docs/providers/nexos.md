---
summary: "Use Nexos AI gateway models in OpenClaw"
read_when:
  - You want to use Nexos AI as a model provider
  - You need Nexos AI setup guidance
title: "Nexos AI"
---

# Nexos AI

Nexos AI is a unified AI gateway that provides OpenAI-compatible access to models from multiple providers (Anthropic, OpenAI, Google, xAI) through a single API endpoint. It includes workspace management, team-based API key governance, and model fallback configuration.

## Why Nexos AI in OpenClaw

- **Multi-provider gateway** — access Claude, GPT, Gemini, and Grok models through one API key.
- **OpenAI-compatible** `/v1` endpoints — works with standard tooling.
- **Team governance** — manage model access, API keys, and usage at the team level.
- **Model fallbacks** — configure automatic fallback chains when a model is unavailable.

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
- **Fast option**: `nexos/Gemini 3 Flash` — good balance of speed and capability.
- **OpenAI**: `nexos/GPT 5.2` or `nexos/GPT 4.1` for GPT-family models.

Change your default model anytime:

```bash
openclaw models set "nexos/Claude Opus 4.6"
openclaw models set "nexos/Gemini 3 Flash"
```

List all available models:

```bash
openclaw models list | grep nexos
```

## Available Models

| Model ID                               | Name              | Context | Features          |
| -------------------------------------- | ----------------- | ------- | ----------------- |
| `Claude Opus 4.6`                      | Claude Opus 4.6   | 1M      | Reasoning, vision |
| `claude-opus-4-20250514`               | Claude Opus 4     | 200k    | Reasoning, vision |
| `anthropic.claude-sonnet-4-5@20250929` | Claude Sonnet 4.5 | 200k    | Reasoning, vision |
| `GPT 5.2`                              | GPT 5.2           | 256k    | Reasoning         |
| `GPT 4.1`                              | GPT 4.1           | 1M      | General           |
| `Gemini 3 Flash`                       | Gemini 3 Flash    | 1M      | Reasoning, vision |
| `Grok 4`                               | Grok 4            | 256k    | Reasoning         |

<Note>
The model catalog may change as Nexos adds or removes models. Use `openclaw models list` to see currently available models.
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

# Use Gemini 3 Flash for fast responses
openclaw agent --model "nexos/Gemini 3 Flash" --message "Quick health check"

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
            contextWindow: 1000000,
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
