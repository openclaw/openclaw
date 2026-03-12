---
name: fin-quick-quote
description: "Crypto market overview — top coins, trending, DeFi TVL, stablecoin stats, exchange tickers, funding rates. Use when user asks about crypto market overview, top coins, DeFi rankings, or market snapshot. NOT for: individual stock analysis (use fin-price-check)."
metadata:
  { "openclaw": { "emoji": "📊", "requires": { "extensions": ["findoo-datahub-slim-plugin"] } } }
---

# Quick Quote — Crypto Market Overview

加密市场快照 — 市值排名、热门币种、DeFi TVL、稳定币、资金费率。

## Tools

### fin_crypto — 21 endpoints

| Parameter  | Type   | Required | Default     | Example       |
| ---------- | ------ | -------- | ----------- | ------------- |
| endpoint   | string | Yes      | coin/market | coin/trending |
| symbol     | string | Depends  | —           | BTC/USDT      |
| start_date | string | No       | —           | 2026-01-01    |
| end_date   | string | No       | —           | 2026-03-12    |
| limit      | number | No       | 20          | 10            |

### Key Endpoints

| Endpoint            | 用途              | 需要 symbol? |
| ------------------- | ----------------- | ------------ |
| coin/market         | 市值排名 Top N    | No           |
| coin/trending       | 热门搜索币种      | No           |
| coin/global_stats   | 全球加密市场概览  | No           |
| market/ticker       | 交易所实时报价    | Yes          |
| market/funding_rate | 永续合约资金费率  | Yes          |
| defi/protocols      | DeFi TVL 排名     | No           |
| defi/stablecoins    | 稳定币市值/流通量 | No           |
| defi/yields         | DeFi 收益率排名   | No           |

### fin_slim_search

| Parameter | Type   | Required | Example |
| --------- | ------ | -------- | ------- |
| query     | string | Yes      | bitcoin |
| market    | string | No       | crypto  |

## Response Guidelines

1. **表格展示** — 排名数据用表格，含：排名、名称、价格、24h 涨跌、市值
2. **数据时效** — 标注数据来源 (CoinGecko/Binance) 和时间
3. **单位换算** — 大数字用 B (billion) / M (million)

## Examples

**用户:** 加密市场现在怎么样？
**流程:** `fin_crypto(endpoint="coin/global_stats")` → 全局快照

**用户:** DeFi 哪个协议 TVL 最高？
**流程:** `fin_crypto(endpoint="defi/protocols", limit=10)` → TVL 排名

**用户:** BTC 资金费率多少？
**流程:** `fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT:USDT")` → 费率
