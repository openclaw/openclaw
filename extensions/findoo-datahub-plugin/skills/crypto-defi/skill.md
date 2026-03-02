---
name: fin-crypto-defi
description: "Crypto & DeFi data — CEX market data (tickers/orderbook/funding), DeFi protocol TVL/yields/stablecoins/DEX volumes, CoinGecko market cap/trending. All via DataHub."
metadata: { "openclaw": { "emoji": "🪙", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Crypto & DeFi

Use the **fin_crypto** tool for cryptocurrency and DeFi analysis via DataHub (works out of the box). For simple OHLCV data, use **fin_data_ohlcv** instead.

## When to Use

- "BTC最新价格" / "Bitcoin ticker"
- "ETH永续资金费率" / "funding rate"
- "DeFi TVL排行" / "DeFi protocol ranking"
- "Aave收益率" / "DeFi yield opportunities"
- "USDT发行量" / "stablecoin market cap"
- "币圈热搜" / "trending coins"

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

## Simple OHLCV (via CCXT)

Use **fin_data_ohlcv** for simple crypto candlestick data via CCXT:

```
fin_data_ohlcv(symbol="BTC/USDT", market="crypto", timeframe="1d")
```

## Market Overview Pattern

1. `fin_crypto(coin/global_stats)` — total market cap, BTC dominance
2. `fin_crypto(coin/market)` — top coins by market cap
3. `fin_crypto(coin/trending)` — what's hot
4. `fin_crypto(defi/protocols)` — DeFi TVL leaders
5. `fin_crypto(defi/chains)` — which chains are growing
