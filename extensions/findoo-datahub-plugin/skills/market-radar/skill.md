---
name: fin-market-radar
description: "Market monitoring — dragon-tiger list, limit-up/down, block trades, sector money flow, margin trading, northbound/southbound capital (Stock Connect), global index, IPO calendar. Includes quantitative anomaly scoring model (0-100) and southbound capital analysis. Use when: user asks about market-wide anomalies, capital flows, or daily market review. NOT for: individual stock analysis (use fin-equity), macro data (use fin-macro)."
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
- "南向资金港股通" / "southbound capital flow"
- "港股通十大成交" / "southbound top 10"
- "沪港通成分股" / "Stock Connect constituents"
- "全球指数表现" / "global index snapshot"
- "本周 IPO" / "IPO calendar"
- "融资买入明细" / "margin trading details"

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

## Endpoints (20 total)

### 龙虎榜 & 异动 (4)

| endpoint            | Description                          | Key Params | Example                                                             |
| ------------------- | ------------------------------------ | ---------- | ------------------------------------------------------------------- |
| `market/top_list`   | Dragon-tiger list (top movers)       | trade_date | `fin_market(endpoint="market/top_list", trade_date="2025-02-28")`   |
| `market/top_inst`   | Institutional trades on dragon-tiger | trade_date | `fin_market(endpoint="market/top_inst", trade_date="2025-02-28")`   |
| `market/limit_list` | Limit-up/down stocks                 | trade_date | `fin_market(endpoint="market/limit_list", trade_date="2025-02-28")` |
| `market/suspend`    | Trading suspensions                  | trade_date | `fin_market(endpoint="market/suspend")`                             |

### 资金流向 (3)

| endpoint                | Description            | Key Params | Example                                                                 |
| ----------------------- | ---------------------- | ---------- | ----------------------------------------------------------------------- |
| `moneyflow/individual`  | Per-stock capital flow | symbol     | `fin_market(endpoint="moneyflow/individual", symbol="600519.SH")`       |
| `moneyflow/industry`    | Sector capital flow    | trade_date | `fin_market(endpoint="moneyflow/industry", trade_date="2025-02-28")`    |
| `moneyflow/block_trade` | Block trade records    | trade_date | `fin_market(endpoint="moneyflow/block_trade", trade_date="2025-02-28")` |

### 融资融券 (3)

| endpoint         | Description                 | Key Params | Example                                                          |
| ---------------- | --------------------------- | ---------- | ---------------------------------------------------------------- |
| `margin/summary` | Market margin summary       | trade_date | `fin_market(endpoint="margin/summary", trade_date="2025-02-28")` |
| `margin/detail`  | Per-stock margin detail     | symbol     | `fin_market(endpoint="margin/detail", symbol="600519.SH")`       |
| `margin/trading` | Margin trading transactions | trade_date | `fin_market(endpoint="margin/trading", trade_date="2025-02-28")` |

### 北向资金 / Stock Connect (4)

| endpoint          | Description                       | Key Params          | Example                                                           |
| ----------------- | --------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `flow/hsgt_flow`  | Northbound/Southbound daily flows | start_date/end_date | `fin_market(endpoint="flow/hsgt_flow", start_date="2025-02-01")`  |
| `flow/hsgt_top10` | Top 10 HSGT holdings              | trade_date          | `fin_market(endpoint="flow/hsgt_top10", trade_date="2025-02-28")` |
| `flow/ggt_daily`  | Southbound (港股通) daily flows   | start_date/end_date | `fin_market(endpoint="flow/ggt_daily", start_date="2025-02-01")`  |
| `flow/ggt_top10`  | Southbound top 10 transactions    | trade_date          | `fin_market(endpoint="flow/ggt_top10", trade_date="2025-02-28")`  |

### 互联互通成分股 (1)

| endpoint        | Description                    | Key Params | Example                                             |
| --------------- | ------------------------------ | ---------- | --------------------------------------------------- |
| `flow/hs_const` | Stock Connect constituent list | symbol     | `fin_market(endpoint="flow/hs_const", symbol="SH")` |

### 市场发现 (5)

| endpoint                | Description       | Key Params | Example                                        |
| ----------------------- | ----------------- | ---------- | ---------------------------------------------- |
| `discovery/gainers`     | Top gainers       | —          | `fin_market(endpoint="discovery/gainers")`     |
| `discovery/losers`      | Top losers        | —          | `fin_market(endpoint="discovery/losers")`      |
| `discovery/active`      | Most active       | —          | `fin_market(endpoint="discovery/active")`      |
| `discovery/new_share`   | IPO calendar      | —          | `fin_market(endpoint="discovery/new_share")`   |
| `market/trade_calendar` | Exchange calendar | —          | `fin_market(endpoint="market/trade_calendar")` |

## Southbound Capital Analysis (港股通南向资金)

南向资金是内地资金投资港股的重要风向标：

```
Step 1: fin_market(flow/ggt_daily, start_date="YYYY-MM-01") → 南向资金日度流量
Step 2: fin_market(flow/ggt_top10, trade_date="YYYY-MM-DD") → 南向十大成交股
```

**信号解读:**

| 南向资金信号              | 含义                       | 操作建议             |
| ------------------------- | -------------------------- | -------------------- |
| 单日净买入 > 50 亿 HKD    | 内地资金大举配置港股       | 关注被买入的重点标的 |
| 连续 5 日净买入           | 趋势性流入，可能有政策催化 | 港股可能有阶段性行情 |
| 单日净卖出 > 30 亿 HKD    | 获利了结或风险回避         | 港股短期承压         |
| 南向集中买某板块 (Top 10) | 主题性配置 (如科技/医药)   | 该板块可能有信息优势 |

**南北向资金综合分析:**

```
fin_market(flow/hsgt_flow)  → 北向资金 (外资→A股)
fin_market(flow/ggt_daily)  → 南向资金 (内资→港股)

├─ 北向流入 + 南向流出 → 外资看好 A 股，内资回撤港股
├─ 北向流出 + 南向流入 → 外资撤离 A 股，内资配置港股
├─ 双向流入 → 整体风险偏好上升
└─ 双向流出 → 整体风险回避
```

## Stock Connect Constituents (互联互通成分股)

```
fin_market(endpoint="flow/hs_const", symbol="SH") → 沪股通标的
fin_market(endpoint="flow/hs_const", symbol="SZ") → 深股通标的
```

用于确认某只股票是否在互联互通名单内（北向资金可买入范围）。

## Post-Market Review Pattern (盘后复盘)

1. **涨跌全貌** `fin_market(market/limit_list)` — 涨停/跌停数量
   - 涨停 > 80 + 跌停 < 10 → 强势行情
   - 跌停 > 50 → 恐慌情绪，次日可能有反弹
2. **龙虎榜** `fin_market(market/top_list)` + `fin_market(market/top_inst)` — 机构动向
   - 机构买入金额 > 卖出金额 → 机构看多
3. **板块资金** `fin_market(moneyflow/industry)` — 行业资金净流入排名
   - 连续 3 日净流入的板块 → 可能有主题行情
4. **北向资金** `fin_market(flow/hsgt_flow)` — 外资动向
   - 单日净流出 > 100 亿 → 外资大幅撤离信号
   - 结合 step 3：如果北向资金重点流入某板块 → 该板块确定性更高
5. **南向资金** `fin_market(flow/ggt_daily)` — 内资港股配置
6. **融资余额** `fin_market(margin/summary)` — 杠杆资金变化
   - 融资余额连续增加 + 指数上涨 → 杠杆资金入场，行情可能加速
   - 融资余额高位 + 指数滞涨 → 注意获利了结风险
7. **融资交易明细** `fin_market(margin/trading)` — 个股融资买入/偿还明细

## Pre-Market Scan Pattern (盘前扫描)

1. **全球指数** `fin_market(discovery/gainers)` — 昨日涨幅前列
2. **交易日历** `fin_market(market/trade_calendar)` — 确认今日是否交易
3. **大宗交易** `fin_market(moneyflow/block_trade)` — 昨日大宗折溢价
   - 溢价成交 → 买方看好（或大股东增持）
   - 大幅折价成交 → 减持信号
4. **IPO 日历** `fin_market(discovery/new_share)` — 本周新股申购/上市

## Quantitative Anomaly Scoring Model (量化异常评分)

替代定性判断，采用 0-100 量化评分系统：

### 数据采集

```
fin_market(market/limit_list)   → 涨停数/跌停数
fin_market(flow/hsgt_flow)      → 北向资金净流入
fin_market(margin/summary)      → 融资余额变化
fin_market(moneyflow/industry)  → 板块集中度
fin_market(market/top_inst)     → 龙虎榜机构净买入
```

### 评分维度 (满分 100)

| 维度                  | 权重 | 评分规则                                                                       |
| --------------------- | ---- | ------------------------------------------------------------------------------ |
| 涨停数信号 (20 pts)   | 20%  | 涨停>100: 20分, 80-100: 15分, 50-80: 10分, 30-50: 5分, <30: 0分                |
| 北向资金 (20 pts)     | 20%  | 净流入>100亿: 20分, 50-100亿: 15分, 0-50亿: 10分, -50-0亿: 5分, <-50亿: 0分    |
| 融资余额变化 (20 pts) | 20%  | 日增>100亿: 20分, 50-100亿: 15分, 0-50亿: 10分, 下降<50亿: 5分, 下降>50亿: 0分 |
| 板块集中度 (20 pts)   | 20%  | Top3板块净流入占比>50%: 20分, 30-50%: 15分, 15-30%: 10分, <15%: 5分            |
| 龙虎榜机构 (20 pts)   | 20%  | 机构净买>10亿: 20分, 5-10亿: 15分, 0-5亿: 10分, 净卖0-5亿: 5分, 净卖>5亿: 0分  |

### 综合评分解读

| 总分区间 | 市场情绪 | 操作建议                       |
| -------- | -------- | ------------------------------ |
| 80-100   | 极度看多 | 强势行情，但注意过热后回调     |
| 70-79    | 看多     | 积极参与，关注领涨板块         |
| 50-69    | 中性偏多 | 结构性机会，精选个股           |
| 30-49    | 中性偏空 | 防御为主，轻仓观望             |
| 10-29    | 看空     | 减仓避险，等待企稳信号         |
| 0-9      | 极度看空 | 恐慌行情，但可能有超跌反弹机会 |

### 评分输出模板

```
市场异常评分: XX / 100 (看多/中性/看空)
├─ 涨停数信号:   XX/20 (涨停 N 家 / 跌停 N 家)
├─ 北向资金:     XX/20 (净流入/流出 +/-XXX 亿元)
├─ 融资余额:     XX/20 (余额 X.XX 万亿，日增 +/-XX 亿)
├─ 板块集中度:   XX/20 (Top3 板块占比 XX%)
└─ 龙虎榜机构:   XX/20 (机构净买入 XX 亿)
综合判断: [一句话市场情绪总结]
```

## Legacy Anomaly Detection (定性参考)

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
- **南向资金 (港股通)**: 收盘后发布，港股交易时间与 A 股不完全重合
- **融资融券**: T+1 发布（今天看到的是昨日数据）
- **融资交易明细**: margin/trading 提供个股级别的融资买入/偿还数据
- **大宗交易**: 收盘后发布
- **trade_date**: 必须是交易日（周末/节假日无数据）
- **discovery/gainers|losers**: 数据来自 yfinance，可能因速率限制偶尔失败
- **hs_const**: 成分股名单不定期调整，以交易所最新公告为准

## Response Guidelines

- 涨停/跌停数量用醒目方式展示（如 "涨停 85 家 / 跌停 12 家"）
- 资金流向用"亿元"单位，净流入为正、净流出为负
- 北向资金: "北向净买入 +52.3 亿元"（始终带正负号）
- 南向资金: "南向净买入 +38.5 亿 HKD"（港币单位）
- 融资余额: "两融余额 1.82 万亿元，较昨日 +45 亿"
- 龙虎榜按买入金额排序展示 Top 5
- 板块资金流向用表格（columns: 板块/净流入/涨跌幅）
- 异常评分结果必须展示完整评分表
- 必须注明交易日期
- 复盘结尾给出简短市场情绪判断（如 "整体偏多/偏空/分化"）
