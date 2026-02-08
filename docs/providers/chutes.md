---
summary: "Use Chutes decentralized AI inference (Bittensor) in OpenClaw"
read_when:
  - You want decentralized AI inference
  - You want Bittensor-powered models
  - You want cost-effective open-source model inference
title: "Chutes (Bittensor)"
---

# Chutes (Bittensor Subnet 64)

**Chutes** is a decentralized AI compute marketplace running on Bittensor's Subnet 64. It provides OpenAI-compatible API access to community-deployed open-source models via distributed miners.

## Why Chutes in OpenClaw

- **Decentralized inference** powered by Bittensor miners worldwide
- **Cost-effective** — generally lower cost than centralized providers
- **OpenAI-compatible** `/v1` endpoints for easy integration
- **Open-source models** — Llama, DeepSeek, Qwen, Mistral, and more
- **No vendor lock-in** — models run on decentralized infrastructure

## How It Works

Chutes connects you to Bittensor's decentralized network:

| Component      | Description                                       |
| -------------- | ------------------------------------------------- |
| **Bittensor**  | Decentralized AI network with incentivized miners |
| **Subnet 64**  | Subnet dedicated to AI inference workloads        |
| **Miners**     | GPU operators running open-source models          |
| **Chutes API** | OpenAI-compatible layer routing to miners         |

## Features

| Feature              | Support                            |
| -------------------- | ---------------------------------- |
| **Streaming**        | ✅ Supported                       |
| **Function calling** | ✅ Supported on compatible models  |
| **Vision/Images**    | ✅ Supported on vision models      |
| **JSON mode**        | ✅ Supported via `response_format` |
| **Embeddings**       | ✅ Available at `/v1/embeddings`   |

## Setup

### 1. Get API Key

1. Sign up at [chutes.ai](https://chutes.ai)
2. Create a Bittensor wallet if needed (for staking/rewards)
3. Navigate to API Keys and create a new key
4. Copy your API key (format: `cpk_xxxxxxxxxxxx`)

### 2. Configure OpenClaw

**Option A: Interactive Setup (Recommended)**

```bash
openclaw onboard --auth-choice chutes-api-key
```

This will:

1. Prompt for your API key (or use existing `CHUTES_API_KEY`)
2. Prompt for your preferred model ID (check [chutes.ai](https://chutes.ai) for available models)
3. Configure the Chutes provider

**Option B: Environment Variable**

```bash
export CHUTES_API_KEY="cpk_xxxxxxxxxxxx"
```

**Option C: Non-interactive**

```bash
openclaw onboard --non-interactive \
  --auth-choice chutes-api-key \
  --chutes-api-key "cpk_xxxxxxxxxxxx" \
  --chutes-model-id "your-model-id"
```

### 3. Verify Setup

```bash
openclaw chat --model chutes/Qwen/Qwen2.5-72B-Instruct "Hello!"
```

## Model Selection

Chutes model IDs follow the format `provider/model-name`. Model availability depends on active Bittensor miners.

### Common Models

| Model ID                             | Name          | Use Case                     |
| ------------------------------------ | ------------- | ---------------------------- |
| `Qwen/Qwen2.5-72B-Instruct`          | Qwen 2.5 72B  | General purpose, recommended |
| `Qwen/Qwen3-235B-A22B-Instruct-2507` | Qwen 3 235B   | Large, powerful              |
| `Qwen/Qwen3-14B`                     | Qwen 3 14B    | Fast, lightweight            |
| `tngtech/DeepSeek-R1T-Chimera`       | DeepSeek R1T  | Strong reasoning             |
| `OpenGVLab/InternVL3-78B`            | InternVL3 78B | Vision tasks                 |
| `unsloth/gemma-3-12b-it`             | Gemma 3 12B   | Fast, efficient              |
| `zai-org/GLM-4.6`                    | GLM 4.6       | Multilingual                 |

### Finding More Models

Visit [chutes.ai](https://chutes.ai) to browse all available models. Availability depends on active miners.

### Changing Your Model

```bash
openclaw models set chutes/Qwen/Qwen2.5-72B-Instruct
```

List configured models:

```bash
openclaw models list | grep chutes
```

## Adding Models to Config

Add models to your config as you discover them on Chutes:

```json5
{
  models: {
    mode: "merge",
    providers: {
      chutes: {
        models: [
          { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen 2.5 72B" },
          { id: "tngtech/DeepSeek-R1T-Chimera", name: "DeepSeek R1T" },
          { id: "Qwen/Qwen3-14B", name: "Qwen 3 14B" },
        ],
      },
    },
  },
}
```

## Handling Model Overload

Since Chutes runs on decentralized Bittensor miners, models may occasionally be overloaded or unavailable. Configure fallback models to handle this:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "chutes/Qwen/Qwen2.5-72B-Instruct",
        fallbacks: ["chutes/Qwen/Qwen3-14B", "chutes/unsloth/gemma-3-12b-it"],
      },
    },
  },
}
```

When the primary model fails, OpenClaw automatically tries the fallback models in order.

**Tips for reliability:**

- Configure 2-3 fallback models from different miners
- Check [chutes.ai](https://chutes.ai) for model availability
- Smaller models (7B, 8B) tend to have more available miners

## Authentication Methods

OpenClaw supports two authentication methods for Chutes:

### API Key (Recommended)

Standard bearer token authentication using a Chutes API key:

```bash
Authorization: Bearer cpk_xxxxxxxxxxxx
```

API keys start with `cpk_` and are the simplest way to authenticate. Get yours at [chutes.ai](https://chutes.ai).

Configure in OpenClaw:

```bash
openclaw onboard --auth-choice chutes-api-key
```

### Bittensor Wallet OAuth (Advanced)

For users with a Bittensor wallet, OpenClaw also supports OAuth-based wallet authentication:

```bash
openclaw onboard --auth-choice chutes
```

This opens a browser for Bittensor wallet login via OAuth PKCE flow. Useful for:

- Miners and validators on Subnet 64
- Users who prefer wallet-based identity
- Staking rewards tracking

Most users should use API key auth — wallet OAuth is optional.

## API Endpoints

Chutes provides two base URLs:

| Endpoint       | URL                        | Purpose                      |
| -------------- | -------------------------- | ---------------------------- |
| **Inference**  | `https://llm.chutes.ai/v1` | Chat completions, embeddings |
| **Management** | `https://api.chutes.ai`    | Account, API keys, usage     |

OpenClaw uses the inference endpoint (`llm.chutes.ai/v1`).

## Usage Examples

```bash
# General purpose model
openclaw chat --model chutes/Qwen/Qwen2.5-72B-Instruct

# Fast lightweight model
openclaw chat --model chutes/Qwen/Qwen3-14B

# Reasoning model
openclaw chat --model chutes/tngtech/DeepSeek-R1T-Chimera
```

## Pricing

Chutes uses TAO-based pricing (Bittensor's native token). Check [chutes.ai](https://chutes.ai) for current rates:

- Pricing varies by model size and miner availability
- Generally cost-effective compared to centralized providers
- No minimum spend or commitment

## Comparison: Chutes vs Centralized Providers

| Aspect                 | Chutes (Decentralized)    | Centralized (OpenAI, etc.) |
| ---------------------- | ------------------------- | -------------------------- |
| **Infrastructure**     | Distributed miners        | Data centers               |
| **Model availability** | Dynamic (miner-dependent) | Fixed catalog              |
| **Pricing**            | TAO-based, competitive    | Fixed per-token            |
| **Latency**            | Varies by miner           | Consistent                 |
| **Privacy**            | Decentralized network     | Provider-controlled        |

## Troubleshooting

### API key not recognized

```bash
echo $CHUTES_API_KEY
openclaw models list | grep chutes
```

Ensure the key starts with `cpk_`.

### Model not available

Model availability depends on active miners. If a model returns an error:

1. Check [chutes.ai](https://chutes.ai) for current model availability
2. Try a different model
3. Wait and retry — miners may come online

### Connection issues

Chutes inference API is at `https://llm.chutes.ai/v1`. Ensure your network allows HTTPS connections.

### Slow responses

Response time depends on miner load and network conditions. For faster responses:

- Use smaller models (8B, 7B)
- Try during off-peak hours

## Config File Example

```json5
{
  env: { CHUTES_API_KEY: "cpk_..." },
  agents: { defaults: { model: { primary: "chutes/Qwen/Qwen2.5-72B-Instruct" } } },
  models: {
    mode: "merge",
    providers: {
      chutes: {
        baseUrl: "https://llm.chutes.ai/v1",
        apiKey: "${CHUTES_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "Qwen/Qwen2.5-72B-Instruct",
            name: "Qwen 2.5 72B Instruct",
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

- [Chutes](https://chutes.ai)
- [Chutes API Documentation](https://chutes.ai/docs)
- [Bittensor](https://bittensor.com)
- [Bittensor Subnet 64 (Chutes)](https://taostats.io/subnets/64)
- [Chutes Discord](https://discord.gg/chutes)
