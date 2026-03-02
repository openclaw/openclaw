---
name: fin-data-query
description: "Generic DataHub query — directly call any of 172 financial data endpoints by path. Fallback when specialized tools don't cover the data need."
metadata: { "openclaw": { "emoji": "🔍", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Data Query (Fallback)

Use the **fin_query** tool as a generic fallback to access any of the 172 DataHub endpoints directly (works out of the box).

## When to Use

- When specialized tools (fin_stock, fin_index, fin_macro, fin_derivatives, fin_crypto, fin_market) don't cover the specific data need
- When querying less common endpoints

## DataHub Categories

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

## Example Calls

```
# ETF fund manager info
fin_query(path="etf/fund/manager", params={"symbol": "110011"})

# Currency historical
fin_query(path="currency/price/historical", params={"symbol": "USDCNH"})

# Company news
fin_query(path="news/company", params={"symbol": "AAPL"})

# Coverage metadata — see all available endpoints
fin_query(path="coverage/providers")
fin_query(path="coverage/commands")
```

## When to Prefer Specialized Tools

| Data Need                   | Use Instead       |
| --------------------------- | ----------------- |
| Stock quote / financials    | `fin_stock`       |
| Index / ETF / Fund          | `fin_index`       |
| GDP / CPI / interest rates  | `fin_macro`       |
| Futures / options / CB      | `fin_derivatives` |
| Crypto / DeFi               | `fin_crypto`      |
| Dragon-tiger / market radar | `fin_market`      |
| Simple OHLCV (CCXT/Yahoo)   | `fin_data_ohlcv`  |
