---
summary: "Use Venice AI privacy-focused models in OpenClaw"
read_when:
  - You want privacy-focused inference in OpenClaw
  - You want Venice AI setup guidance
title: "Venice AI"
---

# Venice AI (Venice highlight)

**Venice** is our highlight Venice setup for privacy-first inference with optional anonymized access to proprietary models.

Venice AI provides privacy-focused AI inference with support for uncensored models and access to major proprietary models through their anonymized proxy. All inference is private by default—no training on your data, no logging.

## Why Venice in OpenClaw

- **Private inference** for open-source models (no logging).
- **Uncensored models** when you need them.
- **Anonymized access** to proprietary models (Opus/GPT/Gemini) when quality matters.
- OpenAI-compatible `/v1` endpoints.

## Privacy Modes

Venice offers two privacy levels — understanding this is key to choosing your model:

| Mode           | Description                                                                                                          | Models                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Private**    | Fully private. Prompts/responses are **never stored or logged**. Ephemeral.                                          | Llama, Qwen, DeepSeek, Kimi, MiniMax, Venice Uncensored, etc. |
| **Anonymized** | Proxied through Venice with metadata stripped. The underlying provider (OpenAI, Anthropic) sees anonymized requests. | Claude, GPT, Gemini, Grok                                     |

## Features

- **Privacy-focused**: Choose between "private" (fully private) and "anonymized" (proxied) modes
- **Uncensored models**: Access to models without content restrictions
- **Major model access**: Use Claude, GPT-5.2, Gemini, Grok via Venice's anonymized proxy
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration
- **Streaming**: ✅ Supported on all models
- **Function calling**: ✅ Supported on select models (check model capabilities)
- **Vision**: ✅ Supported on models with vision capability
- **No hard rate limits**: Fair-use throttling may apply for extreme usage

## Setup

### 1. Get API Key

1. Sign up at [venice.ai](https://venice.ai)
2. Go to **Settings → API Keys → Create new key**
3. Copy your API key (format: `vapi_xxxxxxxxxxxx`)

### 2. Configure OpenClaw

**Option A: Environment Variable**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Option B: Interactive Setup (Recommended)**

```bash
openclaw onboard --auth-choice venice-api-key
```

This will:

1. Prompt for your API key (or use existing `VENICE_API_KEY`)
2. Show all available Venice models
3. Let you pick your default model
4. Configure the provider automatically

**Option C: Non-interactive**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verify Setup

```bash
openclaw chat --model venice/kimi-k2-5 "Hello, are you working?"
```

## Model Selection

After setup, OpenClaw shows all available Venice models. Pick based on your needs:

- **Default (our pick)**: `venice/kimi-k2-5` — strong reasoning + vision, fully private.
- **Best overall quality**: `venice/claude-opus-4-6` for the hardest tasks (via anonymized proxy).
- **Privacy**: Choose "private" models for fully private inference.
- **Capability**: Choose "anonymized" models to access Claude, GPT, Gemini via Venice's proxy.

Change your default model anytime:

```bash
openclaw models set venice/kimi-k2-5
openclaw models set venice/claude-opus-4-6
```

List all available models:

```bash
openclaw models list | grep venice
```

## Configure via `openclaw configure`

1. Run `openclaw configure`
2. Select **Model/auth**
3. Choose **Venice AI**

## Which Model Should I Use?

| Use Case                    | Recommended Model                | Why                                      |
| --------------------------- | -------------------------------- | ---------------------------------------- |
| **General chat (default)**  | `kimi-k2-5`                      | Strong reasoning + vision, fully private |
| **Best overall quality**    | `claude-opus-4-6`                | Opus 4.6 is the strongest for hard tasks |
| **Claude via Venice proxy** | `claude-opus-45`                 | Anonymized proxy, metadata stripped      |
| **Coding**                  | `qwen3-coder-480b-a35b-instruct` | Code-optimized, 256k context             |
| **Vision tasks**            | `kimi-k2-5`                      | Reasoning + vision, private              |
| **Uncensored**              | `venice-uncensored`              | No content restrictions                  |
| **Fast + cheap**            | `qwen3-4b`                       | Lightweight, still capable               |
| **Complex reasoning**       | `deepseek-v3.2`                  | Strong reasoning, private                |

## Available Models (28 Total)

### Private Models (19) — Fully Private, No Logging

| Model ID                         | Name                    | Context (tokens) | Features                       |
| -------------------------------- | ----------------------- | ---------------- | ------------------------------ |
| `kimi-k2-5`                      | Kimi K2.5               | 256k             | **Default**, reasoning, vision |
| `kimi-k2-thinking`               | Kimi K2 Thinking        | 256k             | Reasoning                      |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 128k             | General                        |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 128k             | Fast, lightweight              |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 128k             | Complex tasks                  |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 128k             | Reasoning                      |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 128k             | General                        |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 256k             | Code                           |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 256k             | General                        |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 256k             | Vision                         |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k              | Fast, reasoning                |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 160k             | Reasoning                      |
| `venice-uncensored`              | Venice Uncensored       | 32k              | Uncensored                     |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 128k             | Vision                         |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 198k             | Vision                         |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 128k             | General                        |
| `zai-org-glm-4.7`                | GLM 4.7                 | 198k             | Reasoning, multilingual        |
| `zai-org-glm-4.7-flash`          | GLM 4.7 Flash           | 128k             | Reasoning, fast                |
| `minimax-m21`                    | MiniMax M2.1            | 198k             | Reasoning                      |

### Anonymized Models (9) — Via Venice Proxy

| Model ID                 | Original          | Context (tokens) | Features          |
| ------------------------ | ----------------- | ---------------- | ----------------- |
| `claude-opus-4-6`        | Claude Opus 4.6   | 1M               | Reasoning, vision |
| `claude-opus-45`         | Claude Opus 4.5   | 198k             | Reasoning, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 198k             | Reasoning, vision |
| `openai-gpt-52`          | GPT-5.2           | 256k             | Reasoning         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 256k             | Reasoning, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 198k             | Reasoning, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash    | 256k             | Reasoning, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 256k             | Reasoning, vision |
| `grok-code-fast-1`       | Grok Code Fast 1  | 256k             | Reasoning, code   |

## Model Discovery

OpenClaw automatically discovers models from the Venice API when `VENICE_API_KEY` is set. If the API is unreachable, it falls back to a static catalog.

The `/models` endpoint is public (no auth needed for listing), but inference requires a valid API key.

## Streaming & Tool Support

| Feature              | Support                                                 |
| -------------------- | ------------------------------------------------------- |
| **Streaming**        | ✅ All models                                           |
| **Function calling** | ✅ Most models (check `supportsFunctionCalling` in API) |
| **Vision/Images**    | ✅ Models marked with "Vision" feature                  |
| **JSON mode**        | ✅ Supported via `response_format`                      |

## Pricing

Venice uses a credit-based system. Check [venice.ai/pricing](https://venice.ai/pricing) for current rates:

- **Private models**: Generally lower cost
- **Anonymized models**: Similar to direct API pricing + small Venice fee

## Comparison: Venice vs Direct API

| Aspect       | Venice (Anonymized)           | Direct API          |
| ------------ | ----------------------------- | ------------------- |
| **Privacy**  | Metadata stripped, anonymized | Your account linked |
| **Latency**  | +10-50ms (proxy)              | Direct              |
| **Features** | Most features supported       | Full features       |
| **Billing**  | Venice credits                | Provider billing    |

## Usage Examples

```bash
# Use default model (Kimi K2.5 - reasoning + vision, private)
openclaw chat --model venice/kimi-k2-5

# Use Claude Opus 4.6 via Venice (anonymized)
openclaw chat --model venice/claude-opus-4-6

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Troubleshooting

### API key not recognized

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Ensure the key starts with `vapi_`.

### Model not available

The Venice model catalog updates dynamically. Run `openclaw models list` to see currently available models. Some models may be temporarily offline.

### Connection issues

Venice API is at `https://api.venice.ai/api/v1`. Ensure your network allows HTTPS connections.

## Config file example

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/kimi-k2-5" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2-5",
            name: "Kimi K2.5",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Links

- [Venice AI](https://venice.ai)
- [API Documentation](https://docs.venice.ai)
- [Pricing](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
