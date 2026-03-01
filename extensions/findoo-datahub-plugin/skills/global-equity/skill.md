---
name: fin-global-equity
description: "HK and US equity cross-border research — daily prices, financials, and Stock Connect (HSGT) fund flows."
metadata: { "openclaw": { "emoji": "🌏", "requires": { "extensions": ["fin-data-hub"] } } }
---

# Global Equity Research

Use **fin_stock** and **fin_market** tools for HK/US equity analysis and cross-border fund flows.

## When to Use

- "腾讯港股今天行情" / "00700.HK daily"
- "AAPL earnings" / "苹果财报"
- "北向资金今天流入了多少"
- "沪深港通持股排名"
- "AH stock comparison"

## HK Stocks (via fin_stock)

| query_type   | Example                                                 |
| ------------ | ------------------------------------------------------- |
| `quote`      | `fin_stock(symbol="00700.HK", query_type="quote")`      |
| `historical` | `fin_stock(symbol="00700.HK", query_type="historical")` |
| `income`     | `fin_stock(symbol="00700.HK", query_type="income")`     |

## US Stocks (via fin_stock)

| query_type   | Example                                             |
| ------------ | --------------------------------------------------- |
| `quote`      | `fin_stock(symbol="AAPL", query_type="quote")`      |
| `historical` | `fin_stock(symbol="AAPL", query_type="historical")` |

## Cross-Border Flows (via fin_market)

| query_type   | Description                       | Example                                                                          |
| ------------ | --------------------------------- | -------------------------------------------------------------------------------- |
| `hsgt_flow`  | Northbound/Southbound daily flows | `fin_market(query_type="hsgt_flow", start_date="20250201", end_date="20250228")` |
| `hsgt_top10` | Top 10 HSGT holdings              | `fin_market(query_type="hsgt_top10", trade_date="20250228")`                     |

## Multi-step Pattern

1. `fin_stock(quote)` — HK/US stock valuation
2. `fin_stock(income)` — cross-border financials comparison
3. `fin_market(hsgt_flow)` — capital flow trend
