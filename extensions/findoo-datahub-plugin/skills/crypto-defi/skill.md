---
name: fin-crypto-defi
description: "Crypto & DeFi data — CEX market data (K-lines/tickers/orderbook/funding from 100+ exchanges), DeFi protocol TVL/yields/stablecoins/DEX volumes, CoinGecko market cap/trending."
metadata: { "openclaw": { "emoji": "🪙", "requires": { "extensions": ["fin-data-hub"] } } }
---

# Crypto & DeFi

Use the **fin_crypto** tool from the fin-data-hub plugin for cryptocurrency and DeFi analysis.

## When to Use

- "BTC最新价格" / "Bitcoin price on Binance"
- "ETH K线" / "Ethereum candlestick chart"
- "BTC永续资金费率" / "BTC perpetual funding rate"
- "DeFi TVL排行" / "DeFi protocol TVL ranking"
- "Aave收益率" / "DeFi yield opportunities"
- "USDT发行量" / "stablecoin market cap"
- "币圈热搜" / "trending coins"
- "全球加密市场总览" / "crypto global market cap"

## Available query_types

### CEX Market Data (via CCXT — 100+ exchanges)

| query_type     | Description               | Example                                                                                 |
| -------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `ohlcv`        | K-line / candlestick data | `fin_crypto(query_type="ohlcv", symbol="BTC/USDT", exchange="binance", timeframe="1d")` |
| `ticker`       | Single ticker snapshot    | `fin_crypto(query_type="ticker", symbol="ETH/USDT", exchange="okx")`                    |
| `tickers`      | All tickers on exchange   | `fin_crypto(query_type="tickers", exchange="binance")`                                  |
| `orderbook`    | Order book depth          | `fin_crypto(query_type="orderbook", symbol="BTC/USDT", exchange="binance")`             |
| `trades`       | Recent trades             | `fin_crypto(query_type="trades", symbol="BTC/USDT", exchange="binance")`                |
| `funding_rate` | Perpetual funding rate    | `fin_crypto(query_type="funding_rate", symbol="BTC/USDT:USDT", exchange="binance")`     |
| `search`       | Search trading pairs      | `fin_crypto(query_type="search", symbol="SOL")`                                         |

### CoinGecko Market Intelligence

| query_type        | Description            | Example                                                      |
| ----------------- | ---------------------- | ------------------------------------------------------------ |
| `coin_market`     | Market cap ranking     | `fin_crypto(query_type="coin_market", limit=20)`             |
| `coin_historical` | Coin historical data   | `fin_crypto(query_type="coin_historical", symbol="bitcoin")` |
| `coin_info`       | Coin detail info       | `fin_crypto(query_type="coin_info", symbol="ethereum")`      |
| `coin_categories` | Category rankings      | `fin_crypto(query_type="coin_categories")`                   |
| `coin_trending`   | Trending / hot coins   | `fin_crypto(query_type="coin_trending")`                     |
| `coin_global`     | Global market overview | `fin_crypto(query_type="coin_global")`                       |

### DeFi Protocol Data (via DefiLlama)

| query_type         | Description                 | Example                                                        |
| ------------------ | --------------------------- | -------------------------------------------------------------- |
| `defi_protocols`   | Protocol TVL ranking        | `fin_crypto(query_type="defi_protocols", limit=20)`            |
| `defi_tvl`         | Single protocol TVL history | `fin_crypto(query_type="defi_tvl", symbol="aave")`             |
| `defi_chains`      | Blockchain TVL comparison   | `fin_crypto(query_type="defi_chains")`                         |
| `defi_yields`      | Yield farming opportunities | `fin_crypto(query_type="defi_yields", chain="ethereum")`       |
| `defi_stablecoins` | Stablecoin market data      | `fin_crypto(query_type="defi_stablecoins")`                    |
| `defi_fees`        | Protocol fees/revenue       | `fin_crypto(query_type="defi_fees")`                           |
| `defi_dex_volumes` | DEX trading volumes         | `fin_crypto(query_type="defi_dex_volumes")`                    |
| `defi_coin_prices` | DeFi token prices           | `fin_crypto(query_type="defi_coin_prices", symbol="ethereum")` |

## Multi-step Analysis Pattern

For a crypto market overview:

1. `fin_crypto(coin_global)` — total market cap, BTC dominance, 24h volume
2. `fin_crypto(coin_market)` — top coins by market cap
3. `fin_crypto(coin_trending)` — what's hot right now
4. `fin_crypto(defi_protocols)` — DeFi TVL leaders
5. `fin_crypto(defi_chains)` — which chains are growing

For a specific token deep-dive:

1. `fin_crypto(ticker)` — current price on target exchange
2. `fin_crypto(ohlcv)` — price chart and volume trend
3. `fin_crypto(coin_info)` — project fundamentals
4. `fin_crypto(defi_tvl)` — protocol TVL trend (if DeFi token)
5. `fin_crypto(funding_rate)` — market sentiment via futures
