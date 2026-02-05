---
name: seren-models
description: Access 200+ AI models through Seren. GPT-5, Claude Opus 4.5, Gemini, Llama, Mistral. One wallet, every model. Pay with SerenBucks, earn 20% affiliate commission.
homepage: https://serendb.com/publishers/seren-models
metadata: {"openclaw":{"emoji":"🤖","requires":{"env":["SEREN_API_KEY"]},"primaryEnv":"SEREN_API_KEY"}}
---

# SerenModels - 200+ AI Models

Access over 200 AI models from OpenAI, Anthropic, Google, Meta, and more through a single OpenAI-compatible API. One wallet, every model.

## Pricing

- **5% over provider rates** (unified billing)
- Pay with SerenBucks balance
- **Earn 20% commission** by referring other agents

## Quick Start

```bash
# List all available models
curl https://x402.serendb.com/seren-models/models \
  -H "Authorization: Bearer $SEREN_API_KEY"

# Chat with Claude Opus 4.5
curl -X POST https://x402.serendb.com/seren-models/chat/completions \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-opus-4-20250514",
    "messages": [
      {"role": "user", "content": "Explain quantum computing in simple terms"}
    ]
  }'

# Chat with GPT-5.2
curl -X POST https://x402.serendb.com/seren-models/chat/completions \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-5-turbo",
    "messages": [
      {"role": "user", "content": "Write a Python function to sort a list"}
    ]
  }'

# Chat with Gemini 3 Pro
curl -X POST https://x402.serendb.com/seren-models/chat/completions \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-pro-1.5",
    "messages": [
      {"role": "user", "content": "Analyze this image", "images": ["https://example.com/img.png"]}
    ]
  }'

# Check usage and cost
curl https://x402.serendb.com/seren-models/generation?id={generation_id} \
  -H "Authorization: Bearer $SEREN_API_KEY"
```

## Popular Models

| Provider | Model ID | Use Case |
|----------|----------|----------|
| Anthropic | `anthropic/claude-opus-4-20250514` | Complex reasoning |
| Anthropic | `anthropic/claude-sonnet-4-20250514` | Balanced |
| OpenAI | `openai/gpt-5-turbo` | Fast, capable |
| Google | `google/gemini-pro-1.5` | Multimodal |
| Meta | `meta-llama/llama-3.3-70b` | Open weights |
| Mistral | `mistralai/mistral-large` | European AI |

## Features

- **OpenAI-compatible API**: Drop-in replacement
- **Automatic failover**: High availability
- **Usage tracking**: Per-request cost visibility
- **Streaming**: Real-time responses
- **Function calling**: Tool use support
- **Vision**: Multimodal models

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/models` | GET | List all available models |
| `/chat/completions` | POST | Chat with any model |
| `/generation` | GET | Get usage and cost details |
| `/models/{model}/endpoints` | GET | Check model availability |

## Affiliate Program

Earn commissions by referring other agents:

| Tier | Rate | Requirements |
|------|------|--------------|
| Bronze | 20% | Default |
| Silver | 22% | 10+ conversions |
| Gold | 24% | 50+ conversions |
| Platinum | 26% | 100+ conversions |
| Diamond | 30% | 500+ conversions |

Register at https://affiliates.serendb.com

## Guardrails

- Always call GET /models first to discover available model IDs
- Model IDs include provider prefix (e.g., `anthropic/claude-opus-4-20250514`)
- API key required for all requests
