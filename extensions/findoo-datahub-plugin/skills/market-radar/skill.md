---
name: fin-market-radar
description: "Market monitoring — dragon-tiger list, limit-up/down stats, block trades, sector money flow, margin trading, global index snapshots, IPO calendar. All via DataHub."
metadata: { "openclaw": { "emoji": "📡", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Market Radar

Use the **fin_market** tool for market-wide monitoring and anomaly detection via DataHub (works out of the box).

## When to Use

- "今天龙虎榜" / "dragon-tiger list"
- "涨停板有哪些" / "limit up stocks"
- "大宗交易" / "block trades today"
- "板块资金流向" / "sector money flow"
- "融资融券余额" / "margin balance"
- "北向资金" / "northbound flow"
- "全球指数" / "global index snapshot"

## Available Endpoints

| endpoint                | Description                          | Key Params                |
| ----------------------- | ------------------------------------ | ------------------------- |
| `market/top_list`       | Dragon-tiger list (top movers)       | `trade_date="2025-02-28"` |
| `market/top_inst`       | Institutional trades on dragon-tiger | `trade_date`              |
| `market/limit_list`     | Limit-up/down stocks                 | `trade_date`              |
| `market/suspend`        | Trading suspensions                  | `trade_date`              |
| `market/trade_calendar` | Exchange calendar                    | —                         |
| `moneyflow/individual`  | Per-stock capital flow               | `symbol`                  |
| `moneyflow/industry`    | Sector capital flow                  | `trade_date`              |
| `moneyflow/block_trade` | Block trade records                  | `trade_date`              |
| `margin/summary`        | Market margin summary                | `trade_date`              |
| `margin/detail`         | Per-stock margin detail              | `symbol`                  |
| `flow/hsgt_flow`        | Northbound/Southbound flows          | `start_date`, `end_date`  |
| `flow/hsgt_top10`       | Top HSGT holdings                    | `trade_date`              |
| `discovery/gainers`     | Top gainers                          | —                         |
| `discovery/losers`      | Top losers                           | —                         |
| `discovery/active`      | Most active                          | —                         |
| `discovery/new_share`   | IPO calendar                         | —                         |

## Post-market Review Pattern

1. `fin_market(market/top_list)` — who made the dragon-tiger list
2. `fin_market(market/limit_list)` — limit-up/down count
3. `fin_market(margin/summary)` — margin trading changes
4. `fin_market(flow/hsgt_flow)` — northbound capital trend
