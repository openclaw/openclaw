---
summary: "Production-grade access to China's top AI models (Qwen, DeepSeek, Kimi, GLM) via AIsa"
read_when:
  - You want production-grade Chinese AI models
  - You want discounted Qwen pricing
  - You need one API key for all China models
  - You need AIsa setup guidance
title: "AIsa"
---

# AIsa — China AI Models (Production)

**AIsa** provides production-grade access to China's top AI models through a single API key. As an Alibaba Cloud Qwen Key Account partner, AIsa offers the full Qwen model family at discounted pricing, plus all models aggregated on the [Alibaba Bailian platform](https://bailian.console.alibabacloud.com/) — including Kimi, DeepSeek, and GLM.

> **How does this differ from the [Qwen Portal](/providers/qwen)?**
> The Qwen Portal provider uses a free-tier OAuth flow limited to 2 models and 2,000 requests/day.
> AIsa gives you the full Qwen lineup (Flash, Plus, Max, VL, Coder, Audio) with no daily request caps, at negotiated Key Account pricing.

## Why AIsa

- **Full Qwen model family** — Flash, Plus, Max, VL, Coder, Audio, and more. Not just 2 models.
- **Key Account pricing** — Negotiated discounts on Qwen models through Alibaba Cloud partnership.
- **All China models, one key** — Qwen, Kimi (Moonshot), DeepSeek, GLM (Zhipu) via the Bailian aggregation platform.
- **No daily request limits** — Production-ready, not free-tier.
- **OpenAI-compatible** — Standard `/v1` endpoints, works with any OpenAI SDK.

## Default Models

These three models are pre-configured when you onboard with AIsa:

| Model ID        | Name          | Developer   | Best For                  | Context | Vision |
| --------------- | ------------- | ----------- | ------------------------- | ------- | ------ |
| `qwen3-max`     | Qwen3 Max     | Alibaba     | General-purpose (default) | 256k    | Yes    |
| `deepseek-v3.1` | DeepSeek V3.1 | DeepSeek    | Reasoning                 | 128k    | No     |
| `kimi-k2.5`     | Kimi K2.5     | Moonshot AI | Long-context tasks        | 256k    | No     |

## Full Model Catalog

Beyond the defaults, AIsa provides access to the complete Qwen family and all Bailian platform models.

### Qwen Family (Alibaba) — Key Account Pricing

| Model ID                     | Name             | Best For              |
| ---------------------------- | ---------------- | --------------------- |
| `qwen3-max`                  | Qwen3 Max        | Complex reasoning     |
| `qwen-plus`                  | Qwen Plus        | Balanced cost/quality |
| `qwen-turbo`                 | Qwen Turbo       | Fast, low-cost        |
| `qwen-vl-max`                | Qwen VL Max      | Vision tasks          |
| `qwen2.5-coder-32b-instruct` | Qwen Coder 32B   | Code generation       |
| `qwen-audio-turbo`           | Qwen Audio Turbo | Audio understanding   |

### Other China Models (via Bailian)

| Model ID        | Name          | Developer   |
| --------------- | ------------- | ----------- |
| `deepseek-v3.1` | DeepSeek V3.1 | DeepSeek    |
| `deepseek-r1`   | DeepSeek R1   | DeepSeek    |
| `kimi-k2.5`     | Kimi K2.5     | Moonshot AI |

Browse the full catalogue and pricing at [marketplace.aisa.one/pricing](https://marketplace.aisa.one/pricing).

## Setup

### 1. Get API Key

1. Visit the [AIsa Marketplace](https://marketplace.aisa.one/)
2. Sign up or log in
3. Navigate to API Keys and generate a new key
4. Copy the key

New signups get a minimum of $1 credit instantly.

### 2. Configure OpenClaw

**Option A: Interactive Setup (Recommended)**

```bash
openclaw onboard --auth-choice aisa-api-key
```

**Option B: Environment Variable**

```bash
export AISA_API_KEY="your-api-key-here"
```

### 3. Verify

```bash
openclaw models set aisa/qwen3-max
openclaw tui
```

## Which Model Should I Use?

| Use Case           | Recommended Model            | Why                            |
| ------------------ | ---------------------------- | ------------------------------ |
| **General chat**   | `qwen3-max`                  | Strongest Qwen model (default) |
| **Balanced cost**  | `qwen-plus`                  | Good quality at lower cost     |
| **Fast & cheap**   | `qwen-turbo`                 | Lowest latency and cost        |
| **Coding**         | `qwen2.5-coder-32b-instruct` | Code-optimized                 |
| **Vision tasks**   | `qwen-vl-max`                | Image understanding            |
| **Deep reasoning** | `deepseek-r1`                | Chain-of-thought reasoning     |
| **Long context**   | `kimi-k2.5`                  | 256k context window            |

Change your default model anytime:

```bash
openclaw models set aisa/qwen3-max
openclaw models set aisa/deepseek-v3.1
openclaw models set aisa/kimi-k2.5
```

## Configuration

After onboarding, your `openclaw.json` will include:

```json5
{
  models: {
    providers: {
      aisa: {
        baseUrl: "https://api.aisa.one/v1",
        api: "openai-completions",
        models: [
          { id: "qwen3-max", name: "Qwen3 Max" },
          { id: "deepseek-v3.1", name: "DeepSeek V3.1" },
          { id: "kimi-k2.5", name: "Kimi K2.5" },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "aisa/qwen3-max" },
    },
  },
}
```

## Usage

```bash
# Start the TUI with your default model
openclaw tui

# Switch between models
openclaw models set aisa/qwen3-max
openclaw models set aisa/deepseek-v3.1
openclaw models set aisa/kimi-k2.5
```

## AIsa vs Qwen Portal

| Aspect              | AIsa                                   | Qwen Portal (OAuth)      |
| ------------------- | -------------------------------------- | ------------------------ |
| **Models**          | Full Qwen family + DeepSeek, Kimi, GLM | 2 models (Coder, Vision) |
| **Daily limit**     | No cap                                 | 2,000 requests/day       |
| **Pricing**         | Key Account discounts                  | Free tier                |
| **Other providers** | DeepSeek, Kimi, GLM                    | Qwen only                |
| **Best for**        | Production workloads                   | Quick testing            |

## Troubleshooting

### API key not recognized

```bash
echo $AISA_API_KEY
openclaw models list | grep aisa
```

### Connection issues

AIsa API is at `https://api.aisa.one/v1`. Ensure your network allows HTTPS connections.

## Related Documentation

- [Qwen Portal (free tier)](/providers/qwen)
- [OpenClaw Configuration](/gateway/configuration)
- [Model Providers](/concepts/model-providers)
- [AIsa API Documentation](https://aisa.mintlify.app/api-reference/introduction)
