---
summary: "Use Sarvam AI multilingual models in OpenClaw"
read_when:
  - You want Indian language support in OpenClaw
  - You want Sarvam AI setup guidance
title: "Sarvam AI"
---

# Sarvam AI

**Sarvam AI** provides state-of-the-art multilingual language models optimized for Indian languages with strong reasoning, coding, and conversational capabilities.

## Why Sarvam in OpenClaw

- **Indian Language Excellence**: Native support for 10 most-spoken Indian languages
- **Strong Reasoning**: MoE architecture with excellent math and coding benchmarks
- **Open Source**: Apache 2.0 licensed models
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration

## Features

- **Multilingual**: Optimized for Indian languages (native script, romanized, code-mixed)
- **Efficient MoE Architecture**: 30B (2.4B active) and 105B parameter models
- **Strong Benchmarks**: Math500, HumanEval, MBPP, AIME 25
- **Streaming**: ✅ Supported on all models
- **Function calling**: ✅ Supported
- **Apache 2.0 License**: Fully open source

## Setup

### 1. Get API Key

1. Sign up at [sarvam.ai](https://www.sarvam.ai)
2. Go to **Dashboard → API Keys**
3. Copy your API key

### 2. Configure OpenClaw

**Option A: Environment Variable**

```bash
export SARVAM_API_KEY="your-api-key-here"  # pragma: allowlist secret
```

**Option B: Interactive Setup (Recommended)**

```bash
openclaw onboard --auth-choice sarvam-api-key
```

This will:

1. Prompt for your API key (or use existing `SARVAM_API_KEY`)
2. Show available Sarvam models
3. Let you pick your default model
4. Configure the provider automatically

**Option C: Non-interactive**

```bash
openclaw onboard --non-interactive \
  --auth-choice sarvam-api-key \
  --sarvam-api-key "your-api-key-here"
```

### 3. Verify Setup

```bash
openclaw agent --model sarvam/sarvam-30b --message "Namaste! How are you?"
```

## Model Selection

After setup, OpenClaw shows available Sarvam models:

- **Default model**: `sarvam/sarvam-30b` for balanced performance
- **High-capability option**: `sarvam/sarvam-105b` for maximum quality

Change your default model anytime:

```bash
openclaw models set sarvam/sarvam-30b
openclaw models set sarvam/sarvam-105b
```

List all available models:

```bash
openclaw models list | grep sarvam
```

## Which Model Should I Use?

| Feature                      | Sarvam-30B                               | Sarvam-105B                                    |
| ---------------------------- | ---------------------------------------- | ---------------------------------------------- |
| **Total Parameters**         | 30B (2.4B active)                        | 105B+                                          |
| **Architecture**             | MoE + GQA                                | MoE + MLA                                      |
| **Pre-training Data**        | 16T tokens                               | 12T tokens                                     |
| **Best for**                 | Real-time deployment & conversational AI | Maximum quality, reasoning & agentic workflows |
| **Math500**                  | 97.0                                     | 98.6                                           |
| **AIME 25**                  | 88.3                                     | 88.3 (96.7 w/ tools)                           |
| **Indian Language Win Rate** | 89% avg                                  | 90% avg                                        |
| **Inference**                | H100, L40S, Apple Silicon                | Server-centric (H100)                          |

## Available Models

| Model ID      | Name        | Context | Features                        |
| ------------- | ----------- | ------- | ------------------------------- |
| `sarvam-30b`  | Sarvam 30B  | 128k    | Balanced performance, efficient |
| `sarvam-105b` | Sarvam 105B | 128k    | Maximum quality, flagship model |

## Streaming & Tool Support

| Feature              | Support                            |
| -------------------- | ---------------------------------- |
| **Streaming**        | ✅ All models                      |
| **Function calling** | ✅ Supported                       |
| **Vision/Images**    | ❌ Not currently supported         |
| **JSON mode**        | ✅ Supported via `response_format` |

## Pricing

Sarvam uses a credit-based system. Check [sarvam.ai/pricing](https://www.sarvam.ai/pricing) for current rates.

## Usage Examples

```bash
# Use the default 30B model
openclaw agent --model sarvam/sarvam-30b --message "Explain quantum computing in Hindi"

# Use the 105B model for complex reasoning
openclaw agent --model sarvam/sarvam-105b --message "Write a detailed analysis of India's economy"

# Multi-turn conversation
openclaw agent --model sarvam/sarvam-30b --message "Tell me about Indian classical music" --session music-chat
```

## Troubleshooting

### API key not recognized

```bash
echo $SARVAM_API_KEY
openclaw models list | grep sarvam
```

### Model not available

Run `openclaw models list` to see currently available models. Contact Sarvam support if models are missing.

### Connection issues

Sarvam API is at `https://api.sarvam.ai/v1`. Ensure your network allows HTTPS connections.

## Config file example

```json5
{
  env: { SARVAM_API_KEY: "your-api-key" }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "sarvam/sarvam-30b" } } },
  models: {
    mode: "merge",
    providers: {
      sarvam: {
        baseUrl: "https://api.sarvam.ai/v1",
        apiKey: "${SARVAM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "sarvam-30b",
            name: "Sarvam 30B",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Links

- [Sarvam AI](https://www.sarvam.ai)
- [API Documentation](https://docs.sarvam.ai)
- [Model Documentation](https://docs.sarvam.ai/api-reference-docs/getting-started/models)
- [Pricing](https://www.sarvam.ai/pricing)
- [Blog](https://www.sarvam.ai/blogs)
