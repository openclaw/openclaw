---
name: fin-market-radar
description: "Market monitoring — dragon-tiger list, limit-up/down, block trades, sector money flow, margin trading, northbound capital, global index, IPO calendar. Use when: user asks about market-wide anomalies, capital flows, or daily market review. NOT for: individual stock analysis (use fin-equity), macro data (use fin-macro)."
metadata: { "openclaw": { "emoji": "📡", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Market Radar

Use **fin_market** for market-wide monitoring and anomaly detection via DataHub (works out of the box).

## When to Use

- "今天龙虎榜" / "dragon-tiger list"
- "涨停板有哪些" / "limit up stocks"
- "大宗交易" / "block trades today"
- "板块资金流向" / "sector money flow"
- "融资融券余额" / "margin balance"
- "北向资金今日流入" / "northbound flow"
- "全球指数表现" / "global index snapshot"
- "本周 IPO" / "IPO calendar"

## When NOT to Use

- 个股深度分析 (财报/股东/估值) → use `/fin-equity`
- 宏观经济数据 (GDP/CPI/利率) → use `/fin-macro`
- 加密货币/DeFi → use `/fin-crypto-defi`
- 期货/期权/可转债 → use `/fin-derivatives`
- 172 endpoint 通用查询 → use `/fin-data-query`

## Tools & Parameters

### fin_market

| Parameter  | Type   | Required | Format              | Default | Example         |
| ---------- | ------ | -------- | ------------------- | ------- | --------------- |
| endpoint   | string | Yes      | see endpoint table  | —       | market/top_list |
| trade_date | string | No       | YYYY-MM-DD (交易日) | latest  | 2025-02-28      |
| symbol     | string | No       | stock code          | —       | 600519.SH       |
| start_date | string | No       | YYYY-MM-DD          | —       | 2025-02-01      |
| end_date   | string | No       | YYYY-MM-DD          | —       | 2025-02-28      |
| limit      | number | No       | 1-5000              | 200     | 30              |

## Endpoints

### 龙虎榜 & 异动

| endpoint            | Description                          | Key Params | Example                                                             |
| ------------------- | ------------------------------------ | ---------- | ------------------------------------------------------------------- |
| `market/top_list`   | Dragon-tiger list (top movers)       | trade_date | `fin_market(endpoint="market/top_list", trade_date="2025-02-28")`   |
| `market/top_inst`   | Institutional trades on dragon-tiger | trade_date | `fin_market(endpoint="market/top_inst", trade_date="2025-02-28")`   |
| `market/limit_list` | Limit-up/down stocks                 | trade_date | `fin_market(endpoint="market/limit_list", trade_date="2025-02-28")` |
| `market/suspend`    | Trading suspensions                  | trade_date | `fin_market(endpoint="market/suspend")`                             |

### 资金流向

| endpoint                | Description            | Key Params | Example                                                                 |
| ----------------------- | ---------------------- | ---------- | ----------------------------------------------------------------------- |
| `moneyflow/individual`  | Per-stock capital flow | symbol     | `fin_market(endpoint="moneyflow/individual", symbol="600519.SH")`       |
| `moneyflow/industry`    | Sector capital flow    | trade_date | `fin_market(endpoint="moneyflow/industry", trade_date="2025-02-28")`    |
| `moneyflow/block_trade` | Block trade records    | trade_date | `fin_market(endpoint="moneyflow/block_trade", trade_date="2025-02-28")` |

### 融资融券

| endpoint         | Description             | Key Params | Example                                                          |
| ---------------- | ----------------------- | ---------- | ---------------------------------------------------------------- |
| `margin/summary` | Market margin summary   | trade_date | `fin_market(endpoint="margin/summary", trade_date="2025-02-28")` |
| `margin/detail`  | Per-stock margin detail | symbol     | `fin_market(endpoint="margin/detail", symbol="600519.SH")`       |

### 北向资金 (Stock Connect)

| endpoint          | Description                       | Key Params          | Example                                                           |
| ----------------- | --------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `flow/hsgt_flow`  | Northbound/Southbound daily flows | start_date/end_date | `fin_market(endpoint="flow/hsgt_flow", start_date="2025-02-01")`  |
| `flow/hsgt_top10` | Top 10 HSGT holdings              | trade_date          | `fin_market(endpoint="flow/hsgt_top10", trade_date="2025-02-28")` |

### 市场发现

| endpoint                | Description       | Key Params | Example                                        |
| ----------------------- | ----------------- | ---------- | ---------------------------------------------- |
| `discovery/gainers`     | Top gainers       | —          | `fin_market(endpoint="discovery/gainers")`     |
| `discovery/losers`      | Top losers        | —          | `fin_market(endpoint="discovery/losers")`      |
| `discovery/active`      | Most active       | —          | `fin_market(endpoint="discovery/active")`      |
| `discovery/new_share`   | IPO calendar      | —          | `fin_market(endpoint="discovery/new_share")`   |
| `market/trade_calendar` | Exchange calendar | —          | `fin_market(endpoint="market/trade_calendar")` |

## Post-Market Review Pattern (盘后复盘)

1. **涨跌全貌** `fin_market(market/limit_list)` — 涨停/跌停数量
   - ⚠️ 涨停 > 80 + 跌停 < 10 → 强势行情
   - ⚠️ 跌停 > 50 → 恐慌情绪，次日可能有反弹
2. **龙虎榜** `fin_market(market/top_list)` + `fin_market(market/top_inst)` — 机构动向
   - 💡 机构买入金额 > 卖出金额 → 机构看多
3. **板块资金** `fin_market(moneyflow/industry)` — 行业资金净流入排名
   - 💡 连续 3 日净流入的板块 → 可能有主题行情
4. **北向资金** `fin_market(flow/hsgt_flow)` — 外资动向
   - ⚠️ 单日净流出 > 100 亿 → 外资大幅撤离信号
   - 💡 结合 step 3：如果北向资金重点流入某板块 → 该板块确定性更高
5. **融资余额** `fin_market(margin/summary)` — 杠杆资金变化
   - 💡 融资余额连续增加 + 指数上涨 → 杠杆资金入场，行情可能加速
   - ⚠️ 融资余额高位 + 指数滞涨 → 注意获利了结风险

## Pre-Market Scan Pattern (盘前扫描)

1. **全球指数** `fin_market(discovery/gainers)` — 昨日涨幅前列
2. **交易日历** `fin_market(market/trade_calendar)` — 确认今日是否交易
3. **大宗交易** `fin_market(moneyflow/block_trade)` — 昨日大宗折溢价
   - 💡 溢价成交 → 买方看好（或大股东增持）
   - 💡 大幅折价成交 → 减持信号
4. **IPO 日历** `fin_market(discovery/new_share)` — 本周新股申购/上市

## Anomaly Detection Pattern (异常信号)

当多个信号同时出现时，可信度更高：

| 信号组合                                   | 含义                               | 可信度 |
| ------------------------------------------ | ---------------------------------- | ------ |
| 涨停 > 100 + 北向净流入 > 50 亿 + 融资增加 | 多方共振，强势行情                 | 高     |
| 跌停 > 30 + 北向净流出 > 80 亿 + 融资减少  | 空方共振，弱势行情                 | 高     |
| 龙虎榜机构净买入 + 板块资金净流入          | 机构看好特定板块                   | 中高   |
| 大宗折价成交 + 十大股东减持                | 减持信号（需结合 fin-equity 确认） | 中     |

## Data Notes

- **龙虎榜/涨停**: 收盘后约 18:00 发布，有 1-2 小时延迟
- **北向资金**: 盘中有实时估算（但 DataHub 提供的是收盘确认数据）
- **融资融券**: T+1 发布（今天看到的是昨日数据）
- **大宗交易**: 收盘后发布
- **trade_date**: 必须是交易日（周末/节假日无数据）
- **discovery/gainers|losers**: 数据来自 yfinance，可能因速率限制偶尔失败

## Response Guidelines

- 涨停/跌停数量用醒目方式展示（如 "涨停 85 家 / 跌停 12 家"）
- 资金流向用"亿元"单位，净流入为正、净流出为负
- 北向资金: "北向净买入 +52.3 亿元"（始终带正负号）
- 融资余额: "两融余额 1.82 万亿元，较昨日 +45 亿"
- 龙虎榜按买入金额排序展示 Top 5
- 板块资金流向用表格（columns: 板块/净流入/涨跌幅）
- 必须注明交易日期
- 复盘结尾给出简短市场情绪判断（如 "整体偏多/偏空/分化"）
