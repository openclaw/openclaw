---
name: fin-data-query
description: "Generic DataHub query — access any of 172+ financial data endpoints by path. Use when: specialized tools don't cover the data need, or querying less common endpoints like company news or coverage metadata. NOT for: common queries covered by fin-equity, fin-macro, fin-crypto-defi, fin-derivatives, fin-market-radar, fin-etf, or fin-currency."
metadata: { "openclaw": { "emoji": "🔍", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Data Query (Fallback)

Use **fin_query** as a generic fallback to access any of the 172+ DataHub endpoints directly (works out of the box). Also use **fin_data_markets** to list supported markets and **fin_data_regime** for market regime detection.

The datahub currently has **13 specialized tools** — prefer those for common queries. Use fin_query only when no specialized tool covers the endpoint.

## When to Use

- Specialized tools don't cover the endpoint you need
- Company news
- Coverage metadata (what endpoints/providers exist)
- Market regime detection (bull/bear/sideways)
- Any uncommon endpoint not covered below

## When NOT to Use

- 股票行情/财报/股东 → use `/fin-equity` (fin_stock/fin_index)
- 宏观经济/利率/WorldBank → use `/fin-macro` (fin_macro)
- 加密货币/DeFi → use `/fin-crypto-defi` (fin_crypto)
- 期货/期权/可转债 → use `/fin-derivatives` (fin_derivatives)
- 龙虎榜/涨停/北向/融资 → use `/fin-market-radar` (fin_market)
- ETF/基金 NAV/持仓/分红 → use `/fin-etf` (fin_etf)
- 外汇/汇率 → use `/fin-currency` (fin_currency)

## Tools & Parameters

### fin_query — 通用查询

| Parameter | Type   | Required | Format                        | Default | Example           |
| --------- | ------ | -------- | ----------------------------- | ------- | ----------------- |
| path      | string | Yes      | category/endpoint (see below) | —       | news/company      |
| params    | object | No       | key-value query params        | {}      | {"symbol":"AAPL"} |

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

## DataHub Categories (172+ endpoints)

| Category        | Endpoints | Coverage                                                      |
| --------------- | --------- | ------------------------------------------------------------- |
| `equity/*`      | 83        | A-share, HK, US — prices, fundamentals, ownership, money flow |
| `crypto/*`      | 23        | CEX market data, CoinGecko, DeFi via DefiLlama                |
| `economy/*`     | 23        | China macro, rates, FX, World Bank, Shibor quote, WZ index    |
| `derivatives/*` | 13        | Futures (incl. curve), options, convertible bonds             |
| `index/*`       | 12        | Index data, thematic indices                                  |
| `etf/*`         | 9         | ETF prices, NAV, fund portfolio/manager/dividends/share/adj   |
| `currency/*`    | 4         | FX historical, search, snapshots, news                        |
| `news/*`        | 1         | Company news                                                  |
| `coverage/*`    | 2+        | Provider list, endpoint discovery                             |

## All 13 Specialized Tools

| Tool               | Endpoints | Primary Use Case                                                                  |
| ------------------ | --------- | --------------------------------------------------------------------------------- |
| `fin_stock`        | 22        | A/HK/US stock prices, financials, ownership, flow                                 |
| `fin_index`        | 10        | Index data, constituents, thematic indices                                        |
| `fin_macro`        | 23        | GDP/CPI/PMI/rates/FX/World Bank                                                   |
| `fin_crypto`       | 21        | CEX tickers, CoinGecko, DeFi protocols                                            |
| `fin_derivatives`  | 12        | Futures, options, convertible bonds                                               |
| `fin_market`       | 20        | Dragon-tiger, limit-up, northbound/southbound, margin                             |
| `fin_etf`          | 9         | ETF NAV, info, historical, fund portfolio/manager/dividends/share/adj_nav, search |
| `fin_currency`     | 4         | FX historical prices, search, snapshots, news                                     |
| `fin_ta`           | —         | Technical indicators (SMA/EMA/RSI/MACD/BB)                                        |
| `fin_data_ohlcv`   | —         | Universal OHLCV candles (crypto/equity/commodity)                                 |
| `fin_data_regime`  | —         | Market regime detection (bull/bear/sideways)                                      |
| `fin_data_markets` | —         | List supported markets and endpoint coverage                                      |
| `fin_query`        | all       | Generic fallback for any DataHub endpoint                                         |

## When to Prefer Specialized Tools

| Data Need                   | Use Instead       | Why                                  |
| --------------------------- | ----------------- | ------------------------------------ |
| Stock quote / financials    | `fin_stock`       | Better parameter hints, 22 endpoints |
| Index / thematic            | `fin_index`       | Dedicated index endpoints            |
| GDP / CPI / interest rates  | `fin_macro`       | Macro-specific analysis patterns     |
| Futures / options / CB      | `fin_derivatives` | Derivatives-specific analysis        |
| Crypto / DeFi               | `fin_crypto`      | 20 dedicated crypto endpoints        |
| Dragon-tiger / market radar | `fin_market`      | Market monitoring + anomaly scoring  |
| ETF / Fund NAV / portfolio  | `fin_etf`         | 9 dedicated ETF/fund endpoints       |
| FX / currency               | `fin_currency`    | 4 dedicated FX endpoints             |

## Common Queries (only via fin_query)

```
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
2. `fin_query(path="coverage/commands")` — browse all 172+ endpoints with descriptions
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

- Regime detection uses SMA crossover + ATR analysis on 200+ bars
- Needs sufficient historical data (at least 200 bars), otherwise defaults to "sideways"
- Useful as input for strategy decisions or risk assessment

## Data Notes

- **fin_query 是万能后备**: 任何 DataHub endpoint 都可以通过 path + params 调用
- **coverage/commands**: 返回全量 endpoint 列表，是最可靠的 endpoint 发现方式
- **fin_data_ohlcv**: 带 SQLite 本地缓存，重复查询更快
- **fin_data_regime**: 需要 200+ 根 K 线才能准确检测，数据不足时返回 "sideways"
- **优先使用专用工具**: 13 个专用工具覆盖了绝大多数场景，fin_query 仅用于它们不覆盖的 endpoint

## Response Guidelines

- fin_query 返回原始 JSON，应格式化为可读表格
- 如果返回数据量大 (> 20 行)，只展示 Top 10 + 总数
- 标注使用了哪个 endpoint path（方便用户复用）
- fin_data_regime 结果用简洁格式："当前 regime: **bull** (基于 200 日 K 线)"
- 如果查询失败，建议用 coverage/commands 确认 endpoint 是否存在
