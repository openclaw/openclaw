---
name: fin-market-radar
description: "Market monitoring — dragon-tiger list, limit-up/down stats, block trades, sector money flow, margin trading, global index snapshots, IPO calendar."
metadata: { "openclaw": { "emoji": "📡", "requires": { "extensions": ["fin-data-hub"] } } }
---

# Market Radar

Use the **fin_market** tool for market-wide monitoring and anomaly detection.

## When to Use

- "今天龙虎榜" / "dragon-tiger list"
- "涨停板有哪些" / "limit up stocks"
- "大宗交易" / "block trades today"
- "板块资金流向" / "sector money flow"
- "融资融券余额" / "margin balance"
- "北向资金" / "northbound flow"
- "全球指数" / "global index snapshot"
- "IPO日历" / "IPO calendar"

## Available query_types

| query_type           | Description                          | Key Params               |
| -------------------- | ------------------------------------ | ------------------------ |
| `top_list`           | Dragon-tiger list (top movers)       | `trade_date="20250228"`  |
| `top_inst`           | Institutional trades on dragon-tiger | `trade_date`             |
| `limit_list`         | Limit-up/down stocks                 | `trade_date`             |
| `block_trade`        | Block trade records                  | `trade_date`             |
| `moneyflow_industry` | Sector capital flow                  | `trade_date`             |
| `concept_list`       | Concept/theme sectors                | —                        |
| `concept_detail`     | Concept sector details               | `symbol`                 |
| `margin`             | Market margin summary                | `trade_date`             |
| `margin_detail`      | Per-stock margin detail              | `symbol`                 |
| `hsgt_flow`          | Northbound/Southbound flows          | `start_date`, `end_date` |
| `hsgt_top10`         | Top HSGT holdings                    | `trade_date`             |
| `index_global`       | Global index snapshot                | —                        |
| `market_snapshot`    | Market overview                      | —                        |
| `calendar_ipo`       | IPO calendar                         | —                        |
| `suspend`            | Trading suspensions                  | `trade_date`             |
| `trade_calendar`     | Exchange calendar                    | —                        |

## Post-market Review Pattern

1. `fin_market(top_list)` — who made the dragon-tiger list
2. `fin_market(limit_list)` — limit-up/down count and names
3. `fin_market(margin)` — margin trading changes
4. `fin_market(hsgt_flow)` — northbound capital trend
