---
name: fin-a-northbound-decoder
description: "Northbound capital decoder — HSGT daily flows, top 10 holdings, trend analysis, northbound vs domestic divergence, foreign ownership limits. Use when: user asks about northbound capital, foreign buying, HSGT flows, Stock Connect holdings, or smart money tracking. NOT for: individual stock deep analysis (use fin-a-share), market-wide radar/limit-up stats (use fin-a-share-radar), southbound-only queries (use fin-a-share-radar)."
metadata:
  { "openclaw": { "emoji": "\U0001F9ED", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Northbound Capital Decoder (北向资金解码器)

Decode northbound (HSGT) capital flows — A-share's most transparent "smart money" signal. Use **fin_market** for flow data, **fin_stock** for individual stock cross-validation, **fin_index** for sector context.

## When to Use

- "外资在买什么" / "what are foreign investors buying"
- "北向资金今天流入多少" / "northbound inflow today"
- "陆股通持仓变化" / "Stock Connect holdings change"
- "北向资金最近趋势" / "HSGT flow trend"
- "茅台外资持仓占比" / "foreign ownership ratio of Moutai"
- "北向和内资方向一致吗" / "northbound vs domestic divergence"
- "沪股通深股通哪个流入多" / "Shanghai vs Shenzhen connect split"

## When NOT to Use

- 个股基本面/估值/财报深度分析 → use `/fin-a-share`
- 涨停统计/龙虎榜/板块资金/融资融券全景 → use `/fin-a-share-radar`
- 量化选股/因子筛选 → use `/fin-factor-screen`
- 指数估值定投/PE 分位 → use `/fin-a-index-timer`
- 宏观经济数据 (GDP/CPI/利率) → use `/fin-macro`
- 加密货币 / DeFi → use `/fin-crypto-defi`

## Tools & Parameters

### fin_market — 北向资金数据

| Parameter  | Type   | Required | Format              | Default | Example        |
| ---------- | ------ | -------- | ------------------- | ------- | -------------- |
| endpoint   | string | Yes      | see endpoint table  | —       | flow/hsgt_flow |
| date       | string | No       | YYYY-MM-DD          | latest  | 2026-03-05     |
| trade_date | string | No       | YYYY-MM-DD (交易日) | latest  | 2026-03-05     |
| start_date | string | No       | YYYY-MM-DD          | —       | 2026-02-01     |
| end_date   | string | No       | YYYY-MM-DD          | —       | 2026-02-28     |
| symbol     | string | No       | stock/market code   | —       | 600519.SH / SH |
| limit      | number | No       | 1-5000              | 200     | 30             |

### Endpoints

| endpoint               | Description                       | Key Params          | Example                                                              |
| ---------------------- | --------------------------------- | ------------------- | -------------------------------------------------------------------- |
| `flow/hsgt_flow`       | Northbound/Southbound daily flows | start_date/end_date | `fin_market(endpoint="flow/hsgt_flow", start_date="2026-02-01")`     |
| `flow/hsgt_top10`      | Top 10 HSGT individual holdings   | date                | `fin_market(endpoint="flow/hsgt_top10", date="2026-03-05")`          |
| `flow/hs_const`        | Stock Connect constituent list    | symbol              | `fin_market(endpoint="flow/hs_const", symbol="SH")`                  |
| `flow/ggt_daily`       | Southbound daily flows (对比用)   | start_date/end_date | `fin_market(endpoint="flow/ggt_daily", start_date="2026-02-01")`     |
| `moneyflow/individual` | Per-stock capital flow (交叉验证) | symbol              | `fin_market(endpoint="moneyflow/individual", symbol="600519.SH")`    |
| `moneyflow/industry`   | Sector capital flow (板块归因)    | trade_date          | `fin_market(endpoint="moneyflow/industry", trade_date="2026-03-05")` |

### fin_stock — 个股交叉验证

| endpoint               | Description          | Example                                                          |
| ---------------------- | -------------------- | ---------------------------------------------------------------- |
| `price/historical`     | OHLCV (走势叠加)     | `fin_stock(symbol="600519.SH", endpoint="price/historical")`     |
| `fundamental/ratios`   | PE/PB/ROE (偏好分析) | `fin_stock(symbol="600519.SH", endpoint="fundamental/ratios")`   |
| `moneyflow/individual` | 个股资金流 (背离)    | `fin_stock(symbol="600519.SH", endpoint="moneyflow/individual")` |

### fin_index — 指数相关性

| endpoint           | Description       | Example                                                      |
| ------------------ | ----------------- | ------------------------------------------------------------ |
| `price/historical` | 沪深 300 走势叠加 | `fin_index(symbol="000300.SH", endpoint="price/historical")` |
| `daily_basic`      | 指数 PE/PB (估值) | `fin_index(symbol="000300.SH", endpoint="daily_basic")`      |

## Northbound Flow Analysis Pattern

### Pattern A: 北向日报 (Daily Briefing)

1. **当日净流入** `fin_market(flow/hsgt_flow, start_date=today)` — 获取当日北向资金净买入
   - 拆分沪股通 vs 深股通贡献比例
   - ⚠️ 单日净流出 >100 亿 → 外资系统性撤离信号，需排查美元/美债/地缘风险
   - ⚠️ 单日净流入 >150 亿 → 异常大额流入，可能为 MSCI/FTSE 调仓或被动资金

2. **Top 10 增减持** `fin_market(flow/hsgt_top10, date=today)` — 看外资具体买了什么
   - 按行业归类 Top 10 持股变化
   - ⚠️ 单只个股增持 >5 亿 → 重点外资加仓标的，值得深入分析
   - 💡 交叉验证: Top 10 增持方向 vs `moneyflow/industry` 板块资金方向是否一致

3. **板块归因** `fin_market(moneyflow/industry, trade_date=today)` — 北向买入的板块分布
   - 💡 北向集中买消费+金融 = 配置型资金(稳定); 集中买科技+新能源 = 交易型资金(波动大)

### Pattern B: 趋势分析 (Trend Analysis)

1. **累计流入** `fin_market(flow/hsgt_flow, start_date=N日前, end_date=today)` — 5/10/20 日累计
   - ⚠️ 连续 5 日净流入 且 累计 >200 亿 → risk-on 强趋势
   - ⚠️ 连续 5 日净流出 且 累计 <-150 亿 → risk-off 避险模式
   - ⚠️ 单日反转(连续流入后突然大额流出) → 可能为获利了结，非趋势反转

2. **与沪深 300 相关性** `fin_index(price/historical, symbol="000300.SH")` — 叠加指数走势
   - 💡 北向累计流入创新高 + 沪深 300 未创新高 → 价值修复阶段(外资领先)
   - 💡 沪深 300 创新高 + 北向转流出 → 外资获利了结(警惕顶部)

3. **南北向对比** `fin_market(flow/ggt_daily, start_date=同期)` — 南向资金同期方向
   - 💡 北向流入 + 南向也流入港股 = AH 共振 risk-on(最强信号)
   - 💡 北向流入A + 南向流出港股 = A 股估值/政策优势
   - ⚠️ 北向流出 + 南向也流出 = 全面避险，关注美元/美债

### Pattern C: 个股外资追踪 (Single Stock Foreign Holdings)

1. **北向持仓变化** `fin_market(flow/hsgt_top10)` — 筛选目标个股在 Top 10 中的出现频率
   - 连续 N 日出现在 Top 10 增持 → 外资系统性建仓
   - ⚠️ 外资持仓占流通股比例超过 26% → 接近 28% 外资上限(QFII+HSGT)，触发被动卖出风险
   - ⚠️ 外资持仓占比从高位快速下降 → 可能为 MSCI 权重调整

2. **内资方向对比** `fin_stock(moneyflow/individual, symbol=X)` — 主力资金方向
   - 💡 北向增持 + 内资主力流出 → 长线外资 vs 短线内资，通常 3-6 月后外资正确
   - 💡 北向增持 + 内资主力也流入 → 强共识信号，短中期看多
   - ⚠️ 北向减持 + 内资疯狂流入 → 典型"外资撤退 + 散户接盘"，高风险

3. **估值偏好验证** `fin_stock(fundamental/ratios, symbol=X)` — 确认是否符合北向偏好
   - 北向偏好特征: ROE >15% + PE 合理 + 龙头地位 + 高分红
   - 💡 不符合偏好特征但被大量增持 → 可能为指数被动调仓(非主动选择)

## Signal Quick-Reference

### 北向资金趋势信号

| 信号     | 条件                         | 含义           | 建议               |
| -------- | ---------------------------- | -------------- | ------------------ |
| 强力流入 | 5 日累计 >200 亿 + 连续流入  | 外资系统性看多 | 跟随北向龙头股     |
| 温和流入 | 5 日累计 50-200 亿           | 配置型资金     | 正常偏多           |
| 中性     | 5 日累计 ±50 亿内            | 观望/调仓      | 不作为主要决策依据 |
| 温和流出 | 5 日累计 -50 至 -150 亿      | 获利了结       | 关注但不恐慌       |
| 恐慌流出 | 5 日累计 <-150 亿 + 连续流出 | 系统性风险回避 | 防御为主           |

### 北向 vs 内资背离信号

| 北向方向 | 内资方向 | 解读                      | 历史胜率 |
| -------- | -------- | ------------------------- | -------- |
| 买入     | 买入     | 强共识，短中期上涨概率高  | ~70%     |
| 买入     | 卖出     | 外资领先信号，中期偏多    | ~60%     |
| 卖出     | 买入     | 外资撤退+散户接盘，高风险 | ~55%(空) |
| 卖出     | 卖出     | 一致看空，规避            | ~65%(空) |

### 季节性规律

| 时段     | 典型行为           | 原因                  |
| -------- | ------------------ | --------------------- |
| 1-2 月   | 大额配置性流入     | 全球基金年初建仓      |
| 3-4 月   | 温和+波动          | 两会政策博弈 + 年报季 |
| 5-6 月   | MSCI/FTSE 调仓波动 | 指数半年度审议        |
| 7-8 月   | 交易型为主         | 中报验证期            |
| 9-10 月  | 配置窗口           | Q4 全球配置调整开始   |
| 11-12 月 | 获利了结+年末锁仓  | 基金经理 year-end     |

## Data Notes

- **北向资金流量**: Tushare `flow/hsgt_flow`，收盘后确认数据(非盘中估算)，T+0 发布
- **Top 10 持股**: `flow/hsgt_top10`，仅展示当日交易额 Top 10(非完整持仓)，T+1 发布
- **完整持仓明细**: 需港交所 CCASS 数据(DataHub 当前不覆盖)，Top 10 为近似替代
- **外资持仓占比**: DataHub 无直接端点，需从 Top 10 累计估算(精度有限)
- **MSCI/FTSE 调仓**: 指数调整日被动资金流量大，需区分主动 vs 被动(看调仓日历)
- **沪深拆分**: `flow/hsgt_flow` 包含沪股通/深股通分项数据
- **南向数据**: `flow/ggt_daily` 可用; `flow/ggt_top10` 不可靠(DataHub 超时)，改用 `ggt_daily`

## Response Guidelines

### 数字格式

- 净流入金额: +87.3 亿 / -52.1 亿 (始终带 +/- 符号，保留 1 位小数)
- 累计流入: 5 日累计 +312.5 亿 (注明统计窗口)
- 沪深拆分: 沪股通 +35.2 亿 / 深股通 +52.1 亿 (百分比贡献: 40%/60%)
- 个股增持: +5.3 亿元 (注明占当日北向总额比例)
- 外资持仓占比: 22.3% → 23.1% (注明变化方向和幅度)

### 必须包含

- 数据截止日期 ("数据截至 2026-03-05")
- 沪股通 vs 深股通拆分 (判断外资偏好成长 vs 价值)
- 趋势判断 (连续 N 日方向 + 累计金额)
- 与沪深 300 走势的关联性描述
- 异常流量时注明可能原因 (MSCI 调仓/地缘事件/美债变化)

### 展示方式

- 日报模式 → 一段摘要 + Top 10 表格 (股票/净买入额/行业)
- 趋势分析 → 5/10/20 日累计对比 + 方向判断
- 个股追踪 → 近 N 日北向增减持时间序列 + 背离分析
- 南北向对比 → 并排表格 (日期/北向/南向/解读)
