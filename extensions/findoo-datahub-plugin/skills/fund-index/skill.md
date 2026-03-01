---
name: fin-fund-index
description: "Index / ETF / Fund research — index constituents, valuations, ETF NAV, fund manager evaluation, THS concept tracking."
metadata: { "openclaw": { "emoji": "📈", "requires": { "extensions": ["fin-data-hub"] } } }
---

# Fund & Index

Use the **fin_index** tool for index, ETF, and fund analysis.

## When to Use

- "沪深300成分股" / "CSI 300 constituents"
- "沪深300估值" / "index valuation percentile"
- "50ETF净值" / "ETF NAV"
- "某基金经理持仓" / "fund manager portfolio"
- "同花顺概念板块" / "THS concept sectors"
- "行业分类" / "sector classification"

## Available query_types

| query_type           | Description              | Example                                                          |
| -------------------- | ------------------------ | ---------------------------------------------------------------- |
| `index_historical`   | Index historical data    | `fin_index(symbol="000300.SH", query_type="index_historical")`   |
| `index_constituents` | Index constituent stocks | `fin_index(symbol="000300.SH", query_type="index_constituents")` |
| `index_valuation`    | Index PE/PB valuation    | `fin_index(symbol="000300.SH", query_type="index_valuation")`    |
| `etf_historical`     | ETF historical prices    | `fin_index(symbol="510050.SH", query_type="etf_historical")`     |
| `etf_nav`            | ETF net asset value      | `fin_index(symbol="510050.SH", query_type="etf_nav")`            |
| `fund_manager`       | Fund manager info        | `fin_index(symbol="110011", query_type="fund_manager")`          |
| `fund_portfolio`     | Fund holdings            | `fin_index(symbol="110011", query_type="fund_portfolio")`        |
| `fund_share`         | Fund share changes       | `fin_index(symbol="110011", query_type="fund_share")`            |
| `ths_index`          | THS concept index list   | `fin_index(query_type="ths_index")`                              |
| `ths_daily`          | THS concept daily data   | `fin_index(symbol="885760.TI", query_type="ths_daily")`          |
| `ths_member`         | THS concept members      | `fin_index(symbol="885760.TI", query_type="ths_member")`         |
| `sector_classify`    | Industry classification  | `fin_index(query_type="sector_classify")`                        |

## Index Valuation Comparison Pattern

1. `fin_index(index_valuation)` — current PE/PB vs history
2. `fin_index(index_constituents)` — what's in the index
3. `fin_index(etf_nav)` — corresponding ETF pricing
