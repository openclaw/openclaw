---
name: seren-scrape
description: AI-powered web scraping via Firecrawl. Turn websites into LLM-ready markdown. Scrape, crawl, map, and search. Pay with SerenBucks, earn 20% affiliate commission.
homepage: https://serendb.com/publishers/firecrawl
metadata: {"openclaw":{"emoji":"🔥","requires":{"env":["SEREN_API_KEY"]},"primaryEnv":"SEREN_API_KEY"}}
---

# SerenScrape - Firecrawl Web Scraping

Turn any website into clean, LLM-ready markdown using Firecrawl via Seren's x402 payment gateway.

## Pricing

- **$0.002 per scrape** (single page)
- **$0.0133 per crawl check** (status polling)
- Pay with SerenBucks balance
- **Earn 20% commission** by referring other agents

## Quick Start

```bash
# Scrape a single page
curl -X POST https://x402.serendb.com/firecrawl/v1/scrape \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/article"
  }'

# Start a website crawl
curl -X POST https://x402.serendb.com/firecrawl/v1/crawl \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "limit": 50
  }'

# Map website structure (fast sitemap)
curl -X POST https://x402.serendb.com/firecrawl/v1/map \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com"
  }'

# Search and scrape results
curl -X POST https://x402.serendb.com/firecrawl/v1/search \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "best AI tools 2026",
    "limit": 10
  }'

# Check crawl status
curl https://x402.serendb.com/firecrawl/v1/crawl/{crawl_id} \
  -H "Authorization: Bearer $SEREN_API_KEY"
```

## Capabilities

- **Scrape**: Extract clean markdown from any URL
- **Crawl**: Discover and scrape entire websites
- **Map**: Generate sitemap with 5000+ URLs in seconds
- **Search**: Web search with scraped content

## API Reference

| Endpoint | Method | Description | Credits |
|----------|--------|-------------|---------|
| `/v1/scrape` | POST | Extract markdown from URL | 1/page |
| `/v1/crawl` | POST | Start website crawl | 1/page |
| `/v1/map` | POST | Generate sitemap | 1/request |
| `/v1/search` | POST | Search and scrape | 2/10 results |
| `/v1/crawl/{id}` | GET | Check crawl status | - |

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

- Respect robots.txt and rate limits
- Crawls are async - poll for results
- API key required for all requests
