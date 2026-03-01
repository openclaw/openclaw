---
name: fin-stock-analysis
description: "A-share / HK / US equity deep analysis — quotes, financials (income/balance/cashflow), money flow, holders, dividends, and news."
metadata: { "openclaw": { "emoji": "📊", "requires": { "extensions": ["fin-data-hub"] } } }
---

# Stock Analysis

Use the **fin_stock** tool from the fin-data-hub plugin to perform equity analysis.

## When to Use

- "茅台行情" / "贵州茅台最新股价"
- "AAPL financials" / "苹果的利润表"
- "腾讯资金流向" / "00700.HK money flow"
- "平安银行十大股东" / "holder changes"
- "比亚迪分红记录"

## Available query_types

| query_type    | Description                | Example                                                                         |
| ------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `quote`       | Latest quote / daily basic | `fin_stock(symbol="600519.SH", query_type="quote")`                             |
| `historical`  | Historical OHLCV           | `fin_stock(symbol="600519.SH", query_type="historical", start_date="20250101")` |
| `income`      | Income statement           | `fin_stock(symbol="600519.SH", query_type="income")`                            |
| `balance`     | Balance sheet              | `fin_stock(symbol="600519.SH", query_type="balance")`                           |
| `cashflow`    | Cash flow statement        | `fin_stock(symbol="600519.SH", query_type="cashflow")`                          |
| `ratios`      | Financial ratios           | `fin_stock(symbol="600519.SH", query_type="ratios")`                            |
| `moneyflow`   | Capital flow tracking      | `fin_stock(symbol="600519.SH", query_type="moneyflow")`                         |
| `holders`     | Top 10 shareholders        | `fin_stock(symbol="600519.SH", query_type="holders")`                           |
| `dividends`   | Dividend history           | `fin_stock(symbol="600519.SH", query_type="dividends")`                         |
| `news`        | Stock-related news         | `fin_stock(symbol="600519.SH", query_type="news")`                              |
| `pledge`      | Share pledge data          | `fin_stock(symbol="600519.SH", query_type="pledge")`                            |
| `margin`      | Margin trading data        | `fin_stock(symbol="600519.SH", query_type="margin")`                            |
| `block_trade` | Block trade records        | `fin_stock(symbol="600519.SH", query_type="block_trade")`                       |
| `factor`      | Quantitative factors       | `fin_stock(symbol="600519.SH", query_type="factor")`                            |

## Symbol Format

- A-shares: `600519.SH` (Shanghai), `000001.SZ` (Shenzhen)
- HK stocks: `00700.HK`
- US stocks: `AAPL`

## Multi-step Analysis Pattern

For a comprehensive stock report, call these in sequence:

1. `fin_stock(quote)` — current valuation (PE/PB/Market Cap)
2. `fin_stock(income)` — profitability and revenue trend
3. `fin_stock(cashflow)` — cash generation quality
4. `fin_stock(moneyflow)` — institutional money flow
5. `fin_stock(holders)` — ownership changes

Synthesize findings into a structured report covering: valuation, profitability, growth, capital flow, and ownership.
