---
name: fin-a-earnings-season
description: "A-share earnings season analysis — earnings calendar, consensus surprise, earnings-mine detection (goodwill/receivables/cash flow), post-earnings quick review. Use when: user asks about A-share earnings reports, earnings season, performance forecasts, earnings mines, or quarterly financial disclosure schedule. NOT for: individual stock deep analysis (use fin-a-share), market-wide scan (use fin-a-share-radar), factor screening (use fin-factor-screen)."
metadata: { "openclaw": { "emoji": "📅", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# A-Share Earnings Season Analysis

A 股财报季专项分析：财报日历、预期差、地雷排查、财报后快评。覆盖年报(4月)、中报(8月)、三季报(10月)和业绩预告(1月底截止)。

## When to Use

- "哪些股票要出年报了" / "upcoming annual reports"
- "业绩预告雷区怎么排" / "earnings mine detection"
- "财报季该关注什么" / "what to watch this earnings season"
- "宁德时代年报预期" / "CATL earnings consensus"
- "帮我排查商誉地雷" / "goodwill impairment risk scan"
- "这只股票会不会业绩暴雷" / "earnings surprise risk"
- "年报公布后分析一下" / "post-earnings review"

## When NOT to Use

- 个股全景深度分析 (基本面+筹码+技术面) → use `/fin-a-share`
- 市场整体异常检测/盘后复盘 → use `/fin-a-share-radar`
- 量化因子选股 → use `/fin-factor-screen`
- 宏观经济数据 (GDP/CPI/利率) → use `/fin-macro`
- 加密货币 → use `/fin-crypto`

## Tools & Parameters

### fin_stock — 个股财务数据

| Parameter | Type   | Required | Format             | Default | Example            |
| --------- | ------ | -------- | ------------------ | ------- | ------------------ |
| symbol    | string | Yes      | `{code}.SH/SZ`     | —       | 600519.SH          |
| endpoint  | string | Yes      | see endpoint table | —       | fundamental/income |
| limit     | number | No       | 1-5000             | 200     | 8                  |

#### Key Endpoints

| endpoint                        | Description              | Example                                                                   |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `fundamental/income`            | Income statement         | `fin_stock(symbol="600519.SH", endpoint="fundamental/income", limit=8)`   |
| `fundamental/earnings_forecast` | Analyst consensus        | `fin_stock(symbol="600519.SH", endpoint="fundamental/earnings_forecast")` |
| `fundamental/ratios`            | PE/PB/ROE                | `fin_stock(symbol="600519.SH", endpoint="fundamental/ratios")`            |
| `fundamental/balance`           | Balance sheet (goodwill) | `fin_stock(symbol="600519.SH", endpoint="fundamental/balance", limit=4)`  |
| `fundamental/cash`              | Cash flow statement      | `fin_stock(symbol="600519.SH", endpoint="fundamental/cash", limit=4)`     |
| `fundamental/metrics`           | EV/EBITDA/deducted NI    | `fin_stock(symbol="600519.SH", endpoint="fundamental/metrics")`           |
| `price/historical`              | OHLCV (post-earnings)    | `fin_stock(symbol="600519.SH", endpoint="price/historical", limit=30)`    |

### fin_market — 市场级财报反应

| endpoint            | Description         | Example                                                             |
| ------------------- | ------------------- | ------------------------------------------------------------------- |
| `market/limit_list` | Limit-up/down stats | `fin_market(endpoint="market/limit_list", trade_date="2026-04-28")` |

### fin_index — 行业景气度

| endpoint             | Description      | Example                                    |
| -------------------- | ---------------- | ------------------------------------------ |
| `thematic/ths_index` | THS concept list | `fin_index(endpoint="thematic/ths_index")` |

## Earnings Calendar

A 股财报披露时间表 (硬编码知识):

| 报告类型 | 披露窗口      | 重点关注          |
| -------- | ------------- | ----------------- |
| 年报     | 1月-4月30日   | 4月最密集         |
| 一季报   | 4月-4月30日   | 与年报同步披露    |
| 中报     | 7月-8月31日   | 8月最密集         |
| 三季报   | 10月-10月31日 | 10月最密集        |
| 业绩预告 | 各期截止日前  | 1月底年报预告截止 |
| 业绩快报 | 各期截止日前  | 先于正式报告      |

## Earnings Season Analysis Pattern

### 1. Consensus Surprise Analysis (预期差分析)

```
Step 1: fin_stock(fundamental/income, symbol=X, limit=8) → 近 8 季度净利润/营收
Step 2: fin_stock(fundamental/earnings_forecast, symbol=X) → 分析师一致预期
Step 3: 计算历史 beat/miss 记录

Surprise 计算:
  actual_NI = income 最新季度净利润
  consensus_NI = earnings_forecast 一致预期净利润
  surprise = (actual - consensus) / |consensus| × 100%

  ├─ surprise > +10% → 大幅超预期 (强烈利好)
  ├─ +3% ~ +10% → 小幅超预期 (温和利好)
  ├─ -3% ~ +3% → 符合预期 (中性)
  ├─ -10% ~ -3% → 小幅不及预期 (温和利空)
  └─ < -10% → 大幅低于预期 (暴雷)

  ⚠️ 如果连续 2 季度 miss → 盈利趋势恶化，高风险
  ⚠️ 如果扣非净利 vs 净利差异 >20% → 非经常损益依赖，quality 存疑
  💡 结合 fundamental/ratios 的 PE — 低 PE + 超预期 = 高弹性; 高 PE + miss = 双杀
```

### 2. Earnings Mine Detection (地雷排查)

```
Step 1: fin_stock(fundamental/balance, symbol=X, limit=4) → 近 4 季度资产负债表
Step 2: fin_stock(fundamental/cash, symbol=X, limit=4) → 近 4 季度现金流
Step 3: fin_stock(fundamental/income, symbol=X, limit=4) → 配合验证

四维地雷评分 (0-100, 越高越危险):

Dim 1 — 商誉风险 (0-25):
  goodwill / net_assets 比值
  ├─ < 10% → 0 分
  ├─ 10-20% → 8 分
  ├─ 20-30% → 15 分
  ├─ 30-50% → 20 分
  └─ > 50% → 25 分
  ⚠️ Q4 年报 + 商誉 >30% = 减值高发期

Dim 2 — 应收风险 (0-25):
  accounts_receivable / revenue 比值
  ├─ < 20% → 0 分
  ├─ 20-35% → 8 分
  ├─ 35-50% → 15 分
  └─ > 50% → 25 分
  ⚠️ 应收连续 3 季增速 > 营收增速 → 回款恶化

Dim 3 — 现金流风险 (0-25):
  OCF / net_income 比值
  ├─ > 1.0 → 0 分
  ├─ 0.8-1.0 → 5 分
  ├─ 0.5-0.8 → 12 分
  ├─ 0-0.5 → 20 分
  └─ < 0 (OCF 为负) → 25 分
  ⚠️ 连续 2 季 OCF 为负 → 经营活动不产生现金

Dim 4 — 非经常损益依赖 (0-25):
  (net_income - deducted_net_income) / |net_income|
  ├─ < 10% → 0 分
  ├─ 10-20% → 5 分
  ├─ 20-40% → 12 分
  ├─ 40-70% → 20 分
  └─ > 70% 或扣非为负 → 25 分

地雷等级:
  ├─ 0-20 → 安全 (绿灯)
  ├─ 20-40 → 关注 (黄灯)
  ├─ 40-60 → 警惕 (橙灯)
  ├─ 60-80 → 高危 (红灯)
  └─ 80-100 → 极度危险 (黑灯)

  💡 地雷评分 >60 的公司，建议交叉验证同行业其他公司(行业性风险 vs 个体风险)
```

### 3. Post-Earnings Quick Review (财报后快评)

```
Step 1: fin_stock(fundamental/income, symbol=X, limit=2) → 最新 vs 前期
Step 2: fin_stock(fundamental/earnings_forecast, symbol=X) → consensus
Step 3: fin_stock(price/historical, symbol=X, limit=5) → 财报后价格反应

快评框架:
  1. 关键科目变动: 营收/净利/扣非/毛利率 — 同比 + 环比
  2. Surprise: actual vs consensus → beat/miss 及幅度
  3. 质量验证: OCF 是否同步增长 → 真实盈利 vs 纸面利润
  4. 价格反应: 公布后 1-3 日涨跌幅 → 市场是否已 price-in
  5. 估值重估: 新 EPS 下的 PE → 与行业对比

  ⚠️ Beat + 股价跌 = "sell the news" / 利好出尽，前期涨幅过大
  ⚠️ Miss + 股价不跌 = 利空已 price-in，可能是底部信号
  💡 结合 fin_market(market/limit_list) → 财报后涨停/跌停反应 = 情绪放大器
```

### 4. Batch Earnings Season Dashboard (财报季仪表盘)

```
对 watchlist 或目标板块的多只股票批量扫描:

Step 1: 逐一 fin_stock(fundamental/earnings_forecast, symbol=X)
Step 2: 逐一 fin_stock(fundamental/balance, symbol=X, limit=1) → 商誉快查
Step 3: 汇总为表格

输出表格:
| 股票 | 预计披露 | Consensus NI | 商誉/净资产 | 地雷评分 | 关注等级 |
|------|---------|-------------|------------|---------|---------|

排序: 地雷评分从高到低 → 优先关注高风险标的
💡 如果板块整体地雷评分偏高 → 行业性风险(如传媒/游戏 商誉集中)
```

## Data Notes

- **财报数据**: 季度更新，年报 4 月、中报 8 月、三季报 10 月
- **分析师预期**: `earnings_forecast` 为卖方一致预期，小市值股覆盖可能不足
- **披露日历**: DataHub 无精确披露日期 API，需参考交易所公告或 tushare VIP
- **业绩预告/快报**: 结构化数据有限，以正式报告为准
- **A 股行情**: Tushare 提供，收盘后 ~18:00 更新，非实时
- **地雷评分**: 基于公开财务数据的量化指标，不代表确定性结论，需结合公告定性判断

## Response Guidelines

### 数字格式

- 净利润/营收: > 1 亿用"亿元"，< 1 亿用"万元" (如 "净利润 480.2 亿元")
- 同比变化: +23.5% / -8.2% (始终带 +/- 符号)
- Surprise: +6.3% beat / -4.1% miss (明确标注方向)
- 地雷评分: XX/100 + 等级文字 (如 "72/100 高危")
- PE: 附带行业对比 (如 "PE 28.5x vs 行业 32.1x")

### 必须包含

- 数据截止日期 ("财务数据截至 2025Q3")
- 财报季时间窗口提醒 ("当前处于年报密集披露期，4月30日截止")
- beat/miss 历史记录 ("过去 4 季 beat 3 次、miss 1 次")
- 地雷排查结果的四维拆解 (不只给总分，要给出哪个维度最危险)

### 展示方式

- 单只股票预期差 → 分段叙述: consensus → actual/预期 → surprise → 估值影响
- 多只批量排查 → 表格 (columns: 股票/地雷评分/商誉风险/应收风险/现金流风险/关注等级)
- 历史 beat/miss → 季度时间线表格
- 财报后快评 → 先给结论(超预期/符合/不及), 再展开分析
