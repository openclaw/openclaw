---
summary: "Use Tetrate Agent Router Service to access Public models like Anthropic's Claude, OpenAI's GPT, Google's Gemini, amongst others, in OpenClaw"
read_when:
  - You want to use Tetrate as an AI gateway
  - You need Tetrate Agent Router Service setup guidance
title: "Tetrate Agent Router Service"
---

# Tetrate Agent Router Service

Tetrate Agent Router Service is an OpenAI-compatible AI gateway that provides access to **100+ models** from leading AI providers — all through a single endpoint and API key. Models are automatically discovered at runtime from the `/v1/models` endpoint.

## Prerequisites

1. A Tetrate account with Agent Router Service access at router.tetrate.ai
2. An API key from your Tetrate Agent Router API Keys section
3. OpenClaw installed on your system

## Supported Providers and Models

Tetrate routes to models from multiple providers. Here are some highlights:

### Anthropic Claude

| Model                         | Context Window | Max Output | Vision | Caching |
| ----------------------------- | -------------- | ---------- | ------ | ------- |
| `claude-sonnet-4-6` (default) | 200K           | 64K        | yes    | yes     |
| `claude-opus-4-6`             | 1M             | 128K       | yes    | yes     |
| `claude-haiku-4-5`            | 200K           | 64K        | yes    | yes     |
| `claude-opus-4-5`             | 200K           | 64K        | yes    | yes     |
| + older Claude 3.x variants   |                |            |        |         |

### OpenAI GPT

| Model                                       | Context Window | Max Output | Vision | Reasoning |
| ------------------------------------------- | -------------- | ---------- | ------ | --------- |
| `gpt-5.2`                                   | 400K           | 128K       | yes    | yes       |
| `gpt-5` / `gpt-5-mini` / `gpt-5-nano`       | 400K           | 128K       | yes    | yes       |
| `gpt-5.1`                                   | 400K           | 128K       | yes    | yes       |
| `gpt-4.1` / `gpt-4.1-mini` / `gpt-4.1-nano` | 1M             | 32K        | yes    | no        |
| `o3` / `o4-mini` / `o1`                     | 200K           | 100K       | yes    | yes       |
| + GPT-4o, GPT-4 Turbo, GPT-3.5              |                |            |        |           |

### Google Gemini

| Model                                        | Context Window | Max Output | Vision | Caching |
| -------------------------------------------- | -------------- | ---------- | ------ | ------- |
| `gemini-3-pro-preview`                       | 1M             | 65K        | yes    | yes     |
| `gemini-2.5-pro` / `gemini-2.5-flash`        | 1M             | 65K        | yes    | yes     |
| `gemini-2.0-flash` / `gemini-2.0-flash-lite` | 1M             | 8K         | yes    | varies  |

### xAI Grok

| Model                            | Context Window | Vision | Reasoning |
| -------------------------------- | -------------- | ------ | --------- |
| `xai/grok-4`                     | 256K           | yes    | yes       |
| `xai/grok-4-fast`                | 2M             | yes    | yes       |
| `xai/grok-3` / `xai/grok-3-mini` | 131K           | no     | varies    |
| `xai/grok-code-fast`             | 256K           | no     | yes       |

### Open-Source Models (via DeepInfra)

Access to a wide range of open-source models, including:

- **DeepSeek** — R1, V3, V3.1, V3.2 (reasoning + coding)
- **Meta Llama** — Llama 4 Scout/Maverick, Llama 3.3 70B, Llama 3.1 8B/70B
- **Qwen** — Qwen3 (14B to 480B Coder), Qwen3-VL (vision), Qwen2.5
- **Google Gemma** — Gemma 3 (4B, 12B, 27B with vision)
- **Mistral** — Small 3.2, Mixtral 8x7B, Nemo
- **NVIDIA Nemotron** — Nano, Super, and VL variants
- **Moonshot Kimi** — K2 Instruct, K2 Thinking
- **MiniMax** — M2

### Groq-Hosted Models

Fast inference for select models via Groq, including Llama, Qwen, Kimi, and GPT-OSS.

### Embeddings

Embedding models are also available (OpenAI, Gemini, BAAI, Qwen3-Embedding, sentence-transformers, and more) for RAG and search workflows.

> **Dynamic discovery:** OpenClaw automatically fetches the full model list from the Tetrate API at startup. The models above are a snapshot — new models are available as soon as Tetrate adds them, with no OpenClaw update needed.

## CLI setup

```bash
openclaw onboard --auth-choice tetrate-api-key
```

### Non-interactive

```bash
TETRATE_API_KEY=your-key openclaw onboard --non-interactive --auth-choice tetrate-api-key --accept-risk
```

Or pass the key directly:

```bash
openclaw onboard --non-interactive --auth-choice tetrate-api-key --tetrate-api-key your-key --accept-risk
```

## Environment variable

Set `TETRATE_API_KEY` in your environment and OpenClaw will auto-discover the provider with dynamic model listing from the `/v1/models` endpoint.

## Manual configuration

```json5
{
  models: {
    providers: {
      tetrate: {
        baseUrl: "https://api.router.tetrate.ai/v1",
        api: "openai-completions",
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "tetrate/claude-sonnet-4-6" },
    },
  },
}
```

## Related Documentation

- [OpenClaw Configuration](/gateway/configuration)
- [Model Providers](/concepts/model-providers)
- [Agent Setup](/concepts/agent)
