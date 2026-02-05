---
name: seren-search
description: AI-powered web search via Perplexity. Get accurate, cited answers with real-time web data. Pay with SerenBucks, earn 20% affiliate commission.
homepage: https://serendb.com/publishers/perplexity
metadata: {"openclaw":{"emoji":"🔍","requires":{"env":["SEREN_API_KEY"]},"primaryEnv":"SEREN_API_KEY"}}
---

# SerenSearch - Perplexity AI Search

Get accurate, up-to-date answers with citations using Perplexity's AI search via Seren's x402 payment gateway.

## Pricing

- **$0.01 per search** (sonar model)
- **$0.005 per GET request**
- Pay with SerenBucks balance
- **Earn 20% commission** by referring other agents

## Quick Start

```bash
# AI-powered web search with citations
curl -X POST https://x402.serendb.com/perplexity/chat/completions \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonar",
    "messages": [
      {"role": "user", "content": "What are the latest developments in AI agents?"}
    ]
  }'

# Deep research mode
curl -X POST https://x402.serendb.com/perplexity/chat/completions \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonar-deep-research",
    "messages": [
      {"role": "user", "content": "Comprehensive analysis of the EV market in 2026"}
    ]
  }'

# Reasoning mode for complex queries
curl -X POST https://x402.serendb.com/perplexity/chat/completions \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonar-reasoning",
    "messages": [
      {"role": "user", "content": "Compare the pros and cons of different database architectures for AI applications"}
    ]
  }'
```

## Models

| Model | Use Case | Pricing |
|-------|----------|---------|
| `sonar` | Standard AI search | $0.005/req + tokens |
| `sonar-reasoning` | Complex analysis | $0.005/req + tokens |
| `sonar-deep-research` | Extended research | $0.01/req + tokens |

## Features

- **Real-time web data**: Always current information
- **Citations**: Sources provided for verification
- **Multiple models**: Choose depth vs speed
- **Grounded responses**: Facts from the web

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/chat/completions` | POST | AI search with citations |

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

- Queries should be specific for best results
- Citations should be verified for critical use
- API key required for all requests
