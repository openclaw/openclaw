---
title: BlockRun
purpose: Smart LLM routing with x402 micropayments
use-case: Cost optimization, multi-provider access, agent payments
---

# BlockRun

BlockRun provides **smart LLM routing** with automatic model selection and **x402 micropayments**. Instead of API keys, agents pay per-request with USDC — enabling autonomous operation without human account setup.

## Why BlockRun?

- **Smart routing**: 15-dimension weighted scoring routes each request to the cheapest capable model
- **30+ models**: OpenAI, Anthropic, Google, DeepSeek, xAI, Moonshot through one wallet
- **x402 payments**: Pay per request with USDC on Base, no API keys needed
- **78% cost savings**: Simple tasks go to cheap models, complex tasks to capable ones

## Setup

Install ClawRouter plugin:

```bash
curl -fsSL https://raw.githubusercontent.com/BlockRunAI/ClawRouter/main/scripts/reinstall.sh | bash
```

Fund your wallet with USDC on Base (address printed during install). $5 is enough for thousands of requests.

```bash
openclaw gateway restart
```

## Configuration

```json5
{
  plugins: ["@blockrun/clawrouter"],
  agents: {
    defaults: {
      model: { primary: "blockrun/auto" },
    },
  },
}
```

## Model Identifiers

| Model | Identifier | Cost/M |
|-------|------------|--------|
| Smart routing | `blockrun/auto` | varies |
| GPT-4o | `blockrun/openai/gpt-4o` | $2.50 |
| Claude Sonnet 4 | `blockrun/anthropic/claude-sonnet-4` | $3.00 |
| Gemini 2.5 Flash | `blockrun/google/gemini-2.5-flash` | $0.15 |
| DeepSeek Chat | `blockrun/deepseek/deepseek-chat` | $0.14 |
| Grok 3 | `blockrun/xai/grok-3` | $3.00 |

Full model list: [blockrun.ai/models](https://blockrun.ai/models)

## How Routing Works

```
Request → Weighted Scorer (15 dimensions, <1ms, local)
              │
              ├── High confidence → Pick cheapest capable model
              │
              └── Low confidence → Default to MEDIUM tier (DeepSeek)
```

Example savings:
- "What is 2+2?" → Gemini Flash ($0.60/M) instead of Opus ($75/M) = **99% saved**
- "Build a React app" → Claude Sonnet ($15/M) = best balance
- "Prove this theorem" → DeepSeek-R ($0.42/M) = reasoning tier

## Use Cases

- **Cost optimization**: Reduce LLM spend by 78% without changing workflows
- **Agent autonomy**: Agents generate wallets and pay without human setup
- **Multi-provider access**: One integration for 30+ models across 6 providers

## Links

- **GitHub**: [github.com/BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter)
- **Docs**: [blockrun.ai/docs](https://blockrun.ai/docs)
- **npm**: [@blockrun/clawrouter](https://npmjs.com/package/@blockrun/clawrouter)
