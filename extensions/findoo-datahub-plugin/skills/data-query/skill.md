---
name: fin-data-query
description: "Generic DataHub query fallback — access any of 168+ financial data endpoints by path. Also provides OHLCV candle data with caching, market regime detection, and supported markets listing. Use when: specialized tools (fin_stock/fin_crypto/fin_macro/etc.) don't cover the data need, or querying uncommon endpoints like company news or coverage metadata. NOT for: common queries covered by fin-a-share/fin-us-equity/fin-hk-stock, fin-macro, fin-crypto, fin-derivatives, fin-a-share-radar, fin-etf-fund."
metadata: { "openclaw": { "emoji": "🔍", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Data Query (Fallback)

Use **fin_query** as a generic fallback to access any of the 168+ DataHub endpoints directly. Also use **fin_data_ohlcv** for K-line data, **fin_data_markets** for supported markets, and **fin_data_regime** for market regime detection.

The datahub has **8 specialized query tools** (fin_stock, fin_index, fin_macro, fin_crypto, fin_derivatives, fin_market, fin_etf, fin_currency) plus fin_ta — prefer those for common queries. Use fin_query only when no specialized tool covers the endpoint.

## Skill Routing Quick-Check

Before proceeding, check if a specialized skill handles this query better:

| User Intent (keywords)         | Route to            |
| ------------------------------ | ------------------- |
| A 股 / 茅台 / 沪深             | `fin-a-share`       |
| AAPL / US earnings / S&P 500   | `fin-us-equity`     |
| 00700.HK / 港股                | `fin-hk-stock`      |
| BTC / DeFi / CEX               | `fin-crypto`        |
| GDP / CPI / 宏观               | `fin-macro`         |
| 期货 / 期权 / 可转债           | `fin-derivatives`   |
| 基金 / ETF / NAV               | `fin-etf-fund`      |
| 市场复盘 / 涨跌排行            | `fin-a-share-radar` |
| 选股 / 因子筛选                | `fin-factor-screen` |
| 资产配置 / 跨市场              | `fin-cross-asset`   |
| 风险评估 / VaR                 | `fin-risk-monitor`  |
| **None match** → proceed below | `fin-data-query`    |

## Tools & Parameters

### fin_query — Generic Query

| Parameter | Type   | Required | Format                        | Default | Example           |
| --------- | ------ | -------- | ----------------------------- | ------- | ----------------- |
| path      | string | Yes      | category/endpoint (see below) | —       | news/company      |
| params    | object | No       | key-value query params        | {}      | {"symbol":"AAPL"} |

### fin_data_ohlcv — K-line (OHLCV)

| Parameter | Type   | Required | Format                      | Default | Example  |
| --------- | ------ | -------- | --------------------------- | ------- | -------- |
| symbol    | string | Yes      | trading pair or stock code  | —       | BTC/USDT |
| market    | string | No       | crypto / equity / commodity | crypto  | equity   |
| timeframe | string | No       | 1m / 5m / 1h / 4h / 1d      | 1h      | 1d       |
| since     | number | No       | Unix timestamp in ms        | —       | —        |
| limit     | number | No       | 1-1000                      | 200     | 100      |

### fin_data_regime — Market Regime Detection

| Parameter | Type   | Required | Format                      | Default | Example   |
| --------- | ------ | -------- | --------------------------- | ------- | --------- |
| symbol    | string | Yes      | trading pair or stock code  | —       | 600519.SH |
| market    | string | No       | crypto / equity / commodity | crypto  | equity    |
| timeframe | string | No       | 1m / 5m / 1h / 4h / 1d      | 4h      | 1d        |

Returns: `bull` / `bear` / `sideways` / `volatile` / `crisis`

### fin_data_markets — Supported Markets

No parameters. Returns supported markets, data categories, and total endpoint count.

## DataHub Categories (168+ endpoints)

| Category        | Endpoints | Coverage                                                      |
| --------------- | --------- | ------------------------------------------------------------- |
| `equity/*`      | 83        | A-share, HK, US — prices, fundamentals, ownership, money flow |
| `crypto/*`      | 23        | CEX market data, CoinGecko, DeFi via DefiLlama                |
| `economy/*`     | 23        | China macro, rates, FX, World Bank, Shibor quote, WZ index    |
| `derivatives/*` | 13        | Futures (incl. curve), options, convertible bonds             |
| `index/*`       | 10        | Index data, thematic indices                                  |
| `etf/*`         | 9         | ETF prices, NAV, fund portfolio/manager/dividends/share/adj   |
| `currency/*`    | 4         | FX historical, search, snapshots, news                        |
| `news/*`        | 1         | Company news                                                  |
| `coverage/*`    | 2+        | Provider list, endpoint discovery                             |

## Removed / Dead Endpoints

以下端点已移除，请勿使用:

| 端点              | 状态                | 替代方案                  |
| ----------------- | ------------------- | ------------------------- |
| `index/members`   | 已移除 (始终返回 0) | 使用 `index/constituents` |
| `index/snapshots` | 已移除 (404 错误)   | 使用 `index/daily_basic`  |
| `flow/ggt_top10`  | 已移除 (超时)       | 使用 `flow/ggt_daily`     |

## Endpoint Discovery Pattern

1. `fin_query(path="coverage/providers")` — see all 38+ data providers
2. `fin_query(path="coverage/commands")` — browse all 168+ endpoints with descriptions
3. Use category prefix to narrow down (equity/, crypto/, economy/, etc.)

## Common Queries (only via fin_query)

```
# Company news
fin_query(path="news/company", params={"symbol": "AAPL"})

# Discover all available endpoints
fin_query(path="coverage/commands")

# List all data providers
fin_query(path="coverage/providers")
```

## Market Regime Usage

```
# Detect if market is bullish/bearish
fin_data_regime(symbol="000300.SH", market="equity", timeframe="1d")
# Returns: "bull" / "bear" / "sideways" / "volatile" / "crisis"

# Crypto regime
fin_data_regime(symbol="BTC/USDT", market="crypto", timeframe="4h")
```

- Uses SMA crossover + ATR analysis on 200+ bars
- Needs 200+ bars of historical data; defaults to "sideways" if insufficient
- Useful as input for strategy decisions or risk assessment

## Data Notes

- **fin_query**: 万能后备，任何 DataHub endpoint 都可通过 path + params 调用
- **fin_data_ohlcv**: 带 SQLite 本地缓存，重复查询更快
- **fin_data_regime**: 需要 200+ 根 K 线，数据不足返回 "sideways"
- **coverage/commands**: 全量 endpoint 列表，最可靠的发现方式
- 查询失败时，建议用 coverage/commands 确认 endpoint 是否存在
- fin_query 返回原始 JSON，大数据量 (>20 行) 只展示 Top 10 + 总数

### 端点参数特殊说明

| 端点                  | 特殊参数                  | 说明                              |
| --------------------- | ------------------------- | --------------------------------- |
| `flow/hsgt_top10`     | 需 `date` (非 trade_date) | 北向 Top10 持股，必须传 date 参数 |
| `flow/hs_const`       | 需 `hs_type` (SH 或 SZ)   | 互联互通成分股，hs_type 必填      |
| `market/stock_limit`  | 需 `symbol`               | 个股涨跌停价，不支持按日期批量    |
| `estimates/consensus` | 仅 yfinance 美股          | A 股不支持，有频率限制            |
| `fixedincome/rate/*`  | 通过 fin_macro 调用       | LIBOR/HIBOR 数据截止 2020-06      |

## Troubleshooting

| Symptom               | Fix                                                       |
| --------------------- | --------------------------------------------------------- |
| "endpoint not found"  | 用 `coverage/commands` 确认 path 拼写和存在性             |
| 返回空数组            | 检查 params 格式 (symbol 大小写、日期格式 YYYYMMDD)       |
| Rate limit / 429      | CoinGecko ~30 req/min, tushare ~200 req/min; 降低请求频率 |
| 数据截断              | 所有 endpoint 返回 JSON 数组; 大结果集自动截断 Top 10     |
| World Bank 自定义指标 | `fin_macro` + path `worldbank/indicator` + 自定义 code    |
