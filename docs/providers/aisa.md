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

## Supported Models

### Qwen Family (Alibaba) — Key Account Pricing

| Model ID | Name | Best For |
| --- | --- | --- |
| `qwen3-plus` | Qwen3 Plus | General-purpose (default) |
| `qwen-max` | Qwen Max | Complex reasoning |
| `qwen-plus` | Qwen Plus | Balanced cost/quality |
| `qwen-turbo` | Qwen Turbo | Fast, low-cost |
| `qwen-vl-max` | Qwen VL Max | Vision tasks |
| `qwen2.5-coder-32b-instruct` | Qwen Coder 32B | Code generation |
| `qwen-audio-turbo` | Qwen Audio Turbo | Audio understanding |

### Other China Models (via Bailian)

| Model ID | Name | Developer |
| --- | --- | --- |
| `deepseek-v3` | DeepSeek V3 | DeepSeek |
| `deepseek-r1` | DeepSeek R1 | DeepSeek |
| `moonshot-v1-128k` | Kimi (Moonshot) | Moonshot AI |
| `glm-4-plus` | GLM-4 Plus | Zhipu AI |

### Global Models

| Model ID | Name | Developer |
| --- | --- | --- |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | Anthropic |
| `gpt-4.1` | GPT 4.1 | OpenAI |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Google |

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
openclaw chat --model aisa/qwen3-plus "Hello, are you working?"
```

## Which Model Should I Use?

| Use Case | Recommended Model | Why |
| --- | --- | --- |
| **General chat** | `qwen3-plus` | Best balance of quality and cost (default) |
| **Complex reasoning** | `qwen-max` | Strongest Qwen model |
| **Fast & cheap** | `qwen-turbo` | Lowest latency and cost |
| **Coding** | `qwen2.5-coder-32b-instruct` | Code-optimized |
| **Vision tasks** | `qwen-vl-max` | Image understanding |
| **Deep reasoning** | `deepseek-r1` | Chain-of-thought reasoning |

Change your default model anytime:

```bash
openclaw models set aisa/qwen3-plus
openclaw models set aisa/qwen-max
openclaw models set aisa/deepseek-r1
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
          { id: "qwen3-plus", name: "Qwen3 Plus" },
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: "aisa/qwen3-plus" }
    }
  }
}
```

## Usage

```bash
# Use the default model (Qwen3 Plus)
openclaw chat

# Qwen models
openclaw chat --model aisa/qwen3-plus
openclaw chat --model aisa/qwen-max
openclaw chat --model aisa/qwen-turbo

# Other China models
openclaw chat --model aisa/deepseek-r1
openclaw chat --model aisa/moonshot-v1-128k

# Global models
openclaw chat --model aisa/claude-sonnet-4-5
openclaw chat --model aisa/gemini-2.5-flash
```

## AIsa vs Qwen Portal

| Aspect | AIsa | Qwen Portal (OAuth) |
| --- | --- | --- |
| **Models** | Full Qwen family + DeepSeek, Kimi, GLM | 2 models (Coder, Vision) |
| **Daily limit** | No cap | 2,000 requests/day |
| **Pricing** | Key Account discounts | Free tier |
| **Other providers** | DeepSeek, Kimi, GLM, Claude, GPT | Qwen only |
| **Best for** | Production workloads | Quick testing |

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
