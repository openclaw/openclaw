---
name: fin-crypto-defi
description: "Crypto & DeFi data — CEX tickers/orderbook/funding, CoinGecko market cap/trending, DeFi TVL/yields/stablecoins/DEX volumes. Use when: user asks about crypto prices, DeFi protocols, or blockchain metrics. NOT for: stocks (use fin-equity), macro (use fin-macro), derivatives (use fin-derivatives)."
metadata: { "openclaw": { "emoji": "🪙", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Crypto & DeFi

Use **fin_crypto** for cryptocurrency and DeFi analysis via DataHub (works out of the box). For simple OHLCV candles, use **fin_data_ohlcv** instead.

## When to Use

- "BTC 最新价格" / "Bitcoin price"
- "ETH 永续资金费率" / "funding rate"
- "DeFi TVL 排行" / "DeFi protocol ranking"
- "Aave 收益率" / "DeFi yield opportunities"
- "USDT 发行量" / "stablecoin market cap"
- "币圈热搜" / "trending coins"
- "DEX 交易量" / "DEX volume comparison"
- "BTC K线" / "BTC/USDT 1h candles"

## When NOT to Use

- 股票/指数/ETF → use `/fin-equity`
- 宏观经济数据 (GDP/CPI/利率) → use `/fin-macro`
- 期货/期权/可转债 → use `/fin-derivatives`
- 龙虎榜/涨停/北向资金 → use `/fin-market-radar`
- 172 endpoint 通用查询 → use `/fin-data-query`

## Tools & Parameters

### fin_crypto

| Parameter | Type   | Required | Format                                  | Default | Example     |
| --------- | ------ | -------- | --------------------------------------- | ------- | ----------- |
| endpoint  | string | Yes      | see endpoint tables                     | —       | coin/market |
| symbol    | string | Depends  | trading pair, coin ID, or protocol slug | —       | BTC/USDT    |
| limit     | number | No       | 1-250                                   | 100     | 20          |

### fin_data_ohlcv — K 线数据

| Parameter | Type   | Required | Format                      | Default | Example  |
| --------- | ------ | -------- | --------------------------- | ------- | -------- |
| symbol    | string | Yes      | trading pair                | —       | BTC/USDT |
| market    | string | No       | crypto / equity / commodity | crypto  | crypto   |
| timeframe | string | No       | 1m / 5m / 1h / 4h / 1d      | 1h      | 4h       |
| since     | number | No       | Unix timestamp in ms        | —       | —        |
| limit     | number | No       | 1-1000                      | 200     | 100      |

## CEX Market Data

| endpoint              | Description            | Example                                                         |
| --------------------- | ---------------------- | --------------------------------------------------------------- |
| `market/ticker`       | Single ticker snapshot | `fin_crypto(endpoint="market/ticker", symbol="BTC/USDT")`       |
| `market/tickers`      | All tickers            | `fin_crypto(endpoint="market/tickers")`                         |
| `market/orderbook`    | Order book depth       | `fin_crypto(endpoint="market/orderbook", symbol="BTC/USDT")`    |
| `market/trades`       | Recent trades          | `fin_crypto(endpoint="market/trades", symbol="BTC/USDT")`       |
| `market/funding_rate` | Perpetual funding rate | `fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT")` |

## CoinGecko Market Intelligence

| endpoint            | Description            | Example                                                    |
| ------------------- | ---------------------- | ---------------------------------------------------------- |
| `coin/market`       | Market cap ranking     | `fin_crypto(endpoint="coin/market", limit=20)`             |
| `coin/historical`   | Coin historical data   | `fin_crypto(endpoint="coin/historical", symbol="bitcoin")` |
| `coin/info`         | Coin detail info       | `fin_crypto(endpoint="coin/info", symbol="ethereum")`      |
| `coin/categories`   | Category rankings      | `fin_crypto(endpoint="coin/categories")`                   |
| `coin/trending`     | Trending / hot coins   | `fin_crypto(endpoint="coin/trending")`                     |
| `coin/global_stats` | Global market overview | `fin_crypto(endpoint="coin/global_stats")`                 |

## DeFi Protocol Data (DefiLlama)

| endpoint              | Description                 | Example                                                      |
| --------------------- | --------------------------- | ------------------------------------------------------------ |
| `defi/protocols`      | Protocol TVL ranking        | `fin_crypto(endpoint="defi/protocols", limit=20)`            |
| `defi/tvl_historical` | Full TVL history            | `fin_crypto(endpoint="defi/tvl_historical")`                 |
| `defi/protocol_tvl`   | Single protocol TVL history | `fin_crypto(endpoint="defi/protocol_tvl", symbol="aave")`    |
| `defi/chains`         | Blockchain TVL comparison   | `fin_crypto(endpoint="defi/chains")`                         |
| `defi/yields`         | Yield farming opportunities | `fin_crypto(endpoint="defi/yields")`                         |
| `defi/stablecoins`    | Stablecoin market data      | `fin_crypto(endpoint="defi/stablecoins")`                    |
| `defi/fees`           | Protocol fees/revenue       | `fin_crypto(endpoint="defi/fees")`                           |
| `defi/dex_volumes`    | DEX trading volumes         | `fin_crypto(endpoint="defi/dex_volumes")`                    |
| `defi/coin_prices`    | DeFi token prices           | `fin_crypto(endpoint="defi/coin_prices", symbol="ethereum")` |

## Market Overview Pattern

1. **全局概览** `fin_crypto(coin/global_stats)` — 总市值、BTC 主导率、24h 交易量
   - ⚠️ 如果 BTC dominance > 60% → 山寨币承压，避免推荐小币种
   - ⚠️ 如果 24h 交易量骤降 > 30% → 市场观望情绪浓
2. **市值排行** `fin_crypto(coin/market, limit=20)` — Top 20 表现
3. **热点追踪** `fin_crypto(coin/trending)` — 当前社区热度
   - 💡 与 step 2 交叉：热度高但市值排名低 → 可能是炒作
4. **DeFi 健康度** `fin_crypto(defi/protocols, limit=10)` — TVL 领先者
   - ⚠️ TVL 高不代表安全，需关注 TVL/Market Cap 比值
5. **链上格局** `fin_crypto(defi/chains)` — 哪些链在增长
   - 💡 如果新链 TVL 周增 > 20% → 可能有生态激励活动

## DeFi Deep Dive Pattern

1. `fin_crypto(defi/protocol_tvl, symbol="<protocol>")` — TVL 趋势
2. `fin_crypto(defi/fees)` — 收入是否可持续（fees/TVL ratio）
3. `fin_crypto(defi/yields)` — 当前收益率 vs 历史中位
   - ⚠️ 如果 yield > 50% APY → 大概率不可持续，标注风险
4. `fin_crypto(defi/stablecoins)` — 稳定币流入流出趋势
   - 💡 稳定币市值增长通常领先于市场上涨

## Data Notes

- **CoinGecko**: 免费 API，约 30 req/min 速率限制，高频查询可能 429
- **DefiLlama**: 无认证，数据约 10 分钟刷新，TVL 数据可靠性高
- **CEX 行情**: 通过 DataHub 聚合，非直连交易所，约 1-5 分钟延迟
- **OHLCV (fin_data_ohlcv)**: 走 CCXT 直连，延迟更低但只支持主流交易对
- **CoinGecko coin ID**: 使用 slug 格式（bitcoin, ethereum, solana），不是 ticker

## Response Guidelines

- BTC/ETH 价格到个位: $67,432 / $3,891
- 山寨币价格保留有效位: $0.0034 / $1.28
- 市值/TVL 用 $B/$M: $1.2T / $4.2B / $850M
- 涨跌幅: +12.5% / -3.8%（始终带符号）
- DeFi yield: 12.3% APY（标注 APY 或 APR）
- 24h 交易量用 $B 单位
- 必须注明数据截止时间
- TVL 数据必须注明 "TVL 高不等于安全，请 DYOR"
