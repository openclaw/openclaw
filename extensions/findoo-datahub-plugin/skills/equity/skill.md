---
name: fin-equity
description: "Equity research — A-share, HK, US stock analysis, financials, money flow, holders, dividends, index/ETF/fund, Stock Connect flows. All via DataHub."
metadata: { "openclaw": { "emoji": "📊", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Equity Research

Use **fin_stock**, **fin_index**, and **fin_market** tools for equity analysis across A-share, HK, and US markets. All data routes through DataHub (works out of the box).

## When to Use

- "茅台行情" / "贵州茅台最新股价" / "AAPL earnings"
- "腾讯港股今天行情" / "00700.HK daily"
- "沪深300成分股" / "CSI 300 constituents"
- "50ETF净值" / "ETF NAV"
- "北向资金" / "Stock Connect flows"

## Stock Data (fin_stock)

| endpoint                  | Description           | Example                                                             |
| ------------------------- | --------------------- | ------------------------------------------------------------------- |
| `price/historical`        | Historical OHLCV      | `fin_stock(symbol="600519.SH", endpoint="price/historical")`        |
| `fundamental/income`      | Income statement      | `fin_stock(symbol="600519.SH", endpoint="fundamental/income")`      |
| `fundamental/balance`     | Balance sheet         | `fin_stock(symbol="600519.SH", endpoint="fundamental/balance")`     |
| `fundamental/cash`        | Cash flow statement   | `fin_stock(symbol="AAPL", endpoint="fundamental/cash")`             |
| `fundamental/ratios`      | Financial ratios      | `fin_stock(symbol="00700.HK", endpoint="fundamental/ratios")`       |
| `fundamental/dividends`   | Dividend history      | `fin_stock(symbol="600519.SH", endpoint="fundamental/dividends")`   |
| `ownership/top10_holders` | Top 10 shareholders   | `fin_stock(symbol="600519.SH", endpoint="ownership/top10_holders")` |
| `moneyflow/individual`    | Capital flow tracking | `fin_stock(symbol="600519.SH", endpoint="moneyflow/individual")`    |
| `discovery/gainers`       | Top gainers           | `fin_stock(endpoint="discovery/gainers")`                           |

## Index / ETF / Fund (fin_index)

| endpoint             | Description              | Example                                                        |
| -------------------- | ------------------------ | -------------------------------------------------------------- |
| `price/historical`   | Index daily data         | `fin_index(symbol="000300.SH", endpoint="price/historical")`   |
| `constituents`       | Index constituent stocks | `fin_index(symbol="000300.SH", endpoint="constituents")`       |
| `daily_basic`        | Index PE/PB valuation    | `fin_index(symbol="000300.SH", endpoint="daily_basic")`        |
| `thematic/ths_index` | THS concept index list   | `fin_index(endpoint="thematic/ths_index")`                     |
| `thematic/ths_daily` | THS concept daily data   | `fin_index(symbol="885760.TI", endpoint="thematic/ths_daily")` |

## Cross-Border Flows (fin_market)

| endpoint          | Description                       | Example                                                           |
| ----------------- | --------------------------------- | ----------------------------------------------------------------- |
| `flow/hsgt_flow`  | Northbound/Southbound daily flows | `fin_market(endpoint="flow/hsgt_flow", start_date="2025-02-01")`  |
| `flow/hsgt_top10` | Top 10 HSGT holdings              | `fin_market(endpoint="flow/hsgt_top10", trade_date="2025-02-28")` |

## Symbol Format

- A-shares: `600519.SH` (Shanghai), `000001.SZ` (Shenzhen)
- HK stocks: `00700.HK`
- US stocks: `AAPL`
- Index: `000300.SH`, ETF: `510050.SH`

## Deep Analysis Pattern

1. `fin_stock(price/historical)` — price trend
2. `fin_stock(fundamental/income)` — profitability
3. `fin_stock(fundamental/cash)` — cash quality
4. `fin_stock(moneyflow/individual)` — institutional flow
5. `fin_stock(ownership/top10_holders)` — ownership changes
6. `fin_market(flow/hsgt_flow)` — cross-border capital
