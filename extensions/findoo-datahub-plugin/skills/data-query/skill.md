---
name: fin-data-query
description: "Generic DataHub query — access any of 172 financial data endpoints by path. Use when: specialized tools don't cover the data need, or querying less common endpoints like ETF NAV, FX, company news. NOT for: common queries covered by fin-equity, fin-macro, fin-crypto-defi, fin-derivatives, or fin-market-radar."
metadata: { "openclaw": { "emoji": "🔍", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Data Query (Fallback)

Use **fin_query** as a generic fallback to access any of the 172 DataHub endpoints directly (works out of the box). Also use **fin_data_markets** to list supported markets and **fin_data_regime** for market regime detection.

## When to Use

- Specialized tools don't cover the endpoint you need
- ETF NAV / fund manager info
- FX historical data (USD/CNH, EUR/USD)
- Company news
- Coverage metadata (what endpoints/providers exist)
- Market regime detection (bull/bear/sideways)

## When NOT to Use

- 股票行情/财报/股东 → use `/fin-equity` (fin_stock/fin_index)
- 宏观经济/利率/WorldBank → use `/fin-macro` (fin_macro)
- 加密货币/DeFi → use `/fin-crypto-defi` (fin_crypto)
- 期货/期权/可转债 → use `/fin-derivatives` (fin_derivatives)
- 龙虎榜/涨停/北向/融资 → use `/fin-market-radar` (fin_market)

## Tools & Parameters

### fin_query — 通用查询

| Parameter | Type   | Required | Format                        | Default | Example                |
| --------- | ------ | -------- | ----------------------------- | ------- | ---------------------- |
| path      | string | Yes      | category/endpoint (see below) | —       | etf/fund/manager       |
| params    | object | No       | key-value query params        | {}      | {"symbol":"510050.SH"} |

### fin_data_ohlcv — K 线数据

| Parameter | Type   | Required | Format                      | Default | Example  |
| --------- | ------ | -------- | --------------------------- | ------- | -------- |
| symbol    | string | Yes      | trading pair or stock code  | —       | BTC/USDT |
| market    | string | No       | crypto / equity / commodity | crypto  | equity   |
| timeframe | string | No       | 1m / 5m / 1h / 4h / 1d      | 1h      | 1d       |
| since     | number | No       | Unix timestamp in ms        | —       | —        |
| limit     | number | No       | 1-1000                      | 200     | 100      |

### fin_data_regime — 市场 Regime 检测

| Parameter | Type   | Required | Format                      | Default | Example   |
| --------- | ------ | -------- | --------------------------- | ------- | --------- |
| symbol    | string | Yes      | trading pair or stock code  | —       | 600519.SH |
| market    | string | No       | crypto / equity / commodity | crypto  | equity    |
| timeframe | string | No       | 1m / 5m / 1h / 4h / 1d      | 4h      | 1d        |

Returns one of: `bull` / `bear` / `sideways` / `volatile` / `crisis`

### fin_data_markets — 支持的市场

No parameters. Returns list of supported markets, data categories, and total endpoint count.

## DataHub Categories (172 endpoints)

| Category        | Endpoints | Coverage                                                      |
| --------------- | --------- | ------------------------------------------------------------- |
| `equity/*`      | 83        | A-share, HK, US — prices, fundamentals, ownership, money flow |
| `crypto/*`      | 23        | CEX market data, CoinGecko, DeFi via DefiLlama                |
| `economy/*`     | 21        | China macro, rates, FX, World Bank                            |
| `derivatives/*` | 13        | Futures, options, convertible bonds                           |
| `index/*`       | 12        | Index data, thematic indices                                  |
| `etf/*`         | 9         | ETF prices, NAV, fund data                                    |
| `currency/*`    | 3         | FX historical, search, snapshots                              |
| `news/*`        | 1         | Company news                                                  |
| `coverage/*`    | 2+        | Provider list, endpoint discovery                             |

## Common Queries (not covered by other skills)

```
# ETF fund manager info
fin_query(path="etf/fund/manager", params={"symbol": "110011"})

# ETF NAV historical
fin_query(path="etf/fund/nav", params={"symbol": "510050.SH"})

# Currency historical (FX)
fin_query(path="currency/price/historical", params={"symbol": "USDCNH"})

# Company news
fin_query(path="news/company", params={"symbol": "AAPL"})

# Discover all available endpoints
fin_query(path="coverage/commands")

# List all data providers
fin_query(path="coverage/providers")
```

## Endpoint Discovery Pattern

When you don't know the exact endpoint path:

1. `fin_query(path="coverage/providers")` — see all 38+ data providers
2. `fin_query(path="coverage/commands")` — browse all 172 endpoints with descriptions
3. Use the category prefix to narrow down (equity/, crypto/, economy/, etc.)
4. Call the specific endpoint with appropriate params

## Market Regime Usage

```
# Detect if market is bullish/bearish
fin_data_regime(symbol="000300.SH", market="equity", timeframe="1d")
# Returns: "bull" / "bear" / "sideways" / "volatile" / "crisis"

# Crypto regime
fin_data_regime(symbol="BTC/USDT", market="crypto", timeframe="4h")
```

- 💡 Regime detection uses SMA crossover + ATR analysis on 200+ bars
- ⚠️ Needs sufficient historical data (at least 200 bars), otherwise defaults to "sideways"
- 💡 Useful as input for strategy decisions or risk assessment

## When to Prefer Specialized Tools

| Data Need                   | Use Instead       | Why                                    |
| --------------------------- | ----------------- | -------------------------------------- |
| Stock quote / financials    | `fin_stock`       | Better parameter hints, more endpoints |
| Index / ETF / Fund          | `fin_index`       | Dedicated index endpoints              |
| GDP / CPI / interest rates  | `fin_macro`       | Macro-specific analysis patterns       |
| Futures / options / CB      | `fin_derivatives` | Derivatives-specific analysis          |
| Crypto / DeFi               | `fin_crypto`      | 19 dedicated crypto endpoints          |
| Dragon-tiger / market radar | `fin_market`      | Market monitoring patterns             |

## Data Notes

- **fin_query 是万能后备**: 任何 DataHub endpoint 都可以通过 path + params 调用
- **coverage/commands**: 返回全量 endpoint 列表，是最可靠的 endpoint 发现方式
- **fin_data_ohlcv**: 带 SQLite 本地缓存，重复查询更快
- **fin_data_regime**: 需要 200+ 根 K 线才能准确检测，数据不足时返回 "sideways"
- **FX 数据**: currency/ 下只有 3 个 endpoint，覆盖有限

## Response Guidelines

- fin_query 返回原始 JSON，应格式化为可读表格
- 如果返回数据量大 (> 20 行)，只展示 Top 10 + 总数
- 标注使用了哪个 endpoint path（方便用户复用）
- fin_data_regime 结果用简洁格式："当前 regime: **bull** (基于 200 日 K 线)"
- 如果查询失败，建议用 coverage/commands 确认 endpoint 是否存在
