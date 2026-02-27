---
summary: "Use EternalAI privacy-focused models in OpenClaw"
read_when:
  - You want privacy-focused inference in OpenClaw
  - You want EternalAI setup guidance
title: "EternalAI"
---

# EternalAI

**EternalAI** provides privacy-focused AI inference. All inference is private by default with no training on your data and no logging.

## Why EternalAI in OpenClaw

- **Private inference** (no logging).
- OpenAI-compatible `/v1` endpoints.

## Features

- **Privacy-focused**: Fully private inference, no logging
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration
- **Streaming**: Supported on all models
- **No hard rate limits**: Fair-use throttling may apply for extreme usage

## Setup

### 1. Get API Key

1. Sign up at [eternalai.org](https://eternalai.org)
2. Go to **Settings > API Keys > Create new key**
3. Copy your API key

### 2. Configure OpenClaw

**Option A: Environment Variable**

```bash
export ETERNALAI_API_KEY="your_api_key_here"
```

**Option B: Interactive Setup (Recommended)**

```bash
openclaw onboard --auth-choice eternalai-api-key
```

This will:

1. Prompt for your API key (or use existing `ETERNALAI_API_KEY`)
2. Show all available EternalAI models
3. Let you pick your default model
4. Configure the provider automatically

**Option C: Non-interactive**

```bash
openclaw onboard --non-interactive \
  --auth-choice eternalai-api-key \
  --eternalai-api-key "your_api_key_here"
```

### 3. Verify Setup

```bash
openclaw chat --model openrouter/z-ai/glm-4.7-flash "Hello, are you working?"
```

## Model Selection

Available models:

| Model ID                        | Name          | Context (tokens) |
| ------------------------------- | ------------- | ---------------- |
| `openrouter/z-ai/glm-4.7-flash` | GLM 4.7 Flash | 131k             |
| `openrouter/z-ai/glm-4.7`       | GLM 4.7       | 131k             |

Default: `openrouter/z-ai/glm-4.7-flash`.

Change your default model anytime:

```bash
openclaw models set eternalai/openrouter/z-ai/glm-4.7
```

List all available models:

```bash
openclaw models list | grep eternalai
```

## Configure via `openclaw configure`

1. Run `openclaw configure`
2. Select **Model/auth**
3. Choose **EternalAI**

## Pricing

EternalAI uses a credit-based system. Check the EternalAI website for current rates.

## Usage Examples

```bash
# Use default model
openclaw chat --model eternalai/openrouter/z-ai/glm-4.7-flash

# Use GLM 4.7
openclaw chat --model eternalai/openrouter/z-ai/glm-4.7
```

## Troubleshooting

### API key not recognized

```bash
echo $ETERNALAI_API_KEY
openclaw models list | grep eternalai
```

Ensure the key is correctly set.

### Model not available

The EternalAI model catalog updates dynamically. Run `openclaw models list` to see currently available models. Some models may be temporarily offline.

### Connection issues

EternalAI API is at `https://mvp-b.eternalai.org/v1`. Ensure your network allows HTTPS connections.

## Config file example

```json5
{
  env: { ETERNALAI_API_KEY: "your_key_here" },
  agents: { defaults: { model: { primary: "eternalai/openrouter/z-ai/glm-4.7-flash" } } },
  models: {
    mode: "merge",
    providers: {
      eternalai: {
        baseUrl: "https://mvp-b.eternalai.org/v1",
        apiKey: "${ETERNALAI_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "openrouter/z-ai/glm-4.7-flash",
            name: "GLM 4.7 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Links

- [EternalAI](https://eternalai.org)
