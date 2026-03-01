---
name: fin-data-query
description: "Generic data query — directly call any of the 162 financial data endpoints by source and endpoint name. Fallback tool when specialized tools don't cover the data need."
metadata: { "openclaw": { "emoji": "🔍", "requires": { "extensions": ["fin-data-hub"] } } }
---

# Data Query (Fallback)

Use the **fin_query** tool from the fin-data-hub plugin as a generic fallback to access any of the 162 data endpoints directly.

## When to Use

- When other specialized tools (fin_stock, fin_index, fin_macro, fin_derivatives, fin_crypto, fin_market) don't cover the specific data need
- When you need to call a raw API endpoint by name
- When querying less common data points not exposed through the specialized tools

## Available Sources

| source          | Description                         | Coverage                                                                             |
| --------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `china_equity`  | A-share equity data via Tushare     | ~80 endpoints: daily, income, balance, cashflow, moneyflow, holders, dividends, etc. |
| `global_equity` | HK/US equity via Tushare + Polygon  | ~30 endpoints: hk_daily, us_daily, polygon OHLCV/financials/options                  |
| `crypto_cex`    | CEX market data via CCXT proxy      | ~7 endpoints: ohlcv, ticker, orderbook, trades, funding_rate                         |
| `defi`          | DeFi protocol data via DefiLlama    | ~10 endpoints: protocols, tvl, chains, yields, stablecoins, fees, dex_volumes        |
| `crypto_market` | Crypto market intel via CoinGecko   | ~6 endpoints: coin_market, coin_historical, coin_info, categories, trending, global  |
| `macro_global`  | Macro data via Tushare + World Bank | ~20 endpoints: gdp, cpi, shibor, lpr, treasury, wb_gdp, wb_population                |

## Example Calls

```
# A-share specific endpoint
fin_query(source="china_equity", endpoint="daily_basic", params={"ts_code": "600519.SH"})

# Polygon US equity options
fin_query(source="global_equity", endpoint="option_chain", params={"symbol": "AAPL"})

# CCXT exchange-specific query
fin_query(source="crypto_cex", endpoint="ohlcv", params={"symbol": "SOL/USDT", "exchange": "bybit", "timeframe": "4h"})

# DefiLlama protocol detail
fin_query(source="defi", endpoint="protocol_tvl", params={"slug": "uniswap"})

# CoinGecko category data
fin_query(source="crypto_market", endpoint="coin_categories", params={})

# World Bank custom indicator
fin_query(source="macro_global", endpoint="wb_indicator", params={"country": "CN", "indicator": "NY.GDP.PCAP.CD"})
```

## When to Prefer Specialized Tools

| Data Need                   | Use This Instead  |
| --------------------------- | ----------------- |
| Stock quote / financials    | `fin_stock`       |
| Index / ETF / Fund          | `fin_index`       |
| GDP / CPI / interest rates  | `fin_macro`       |
| Futures / options / CB      | `fin_derivatives` |
| Crypto prices / DeFi TVL    | `fin_crypto`      |
| Dragon-tiger / market radar | `fin_market`      |

Use `fin_query` only when the above tools don't have the specific endpoint you need.
