---
name: fin-a-index-timer
description: "Index valuation timer for DCA — PE/PB percentile scoring, traffic-light signal system, dynamic dollar-cost averaging, multi-index comparison, equity-bond spread. Use when: user asks about index valuation, DCA timing, PE percentile, whether to invest in CSI 300/500, or index fund allocation. NOT for: individual stock analysis (use fin-a-share), market-wide radar/limit-up (use fin-a-share-radar), factor screening (use fin-factor-screen)."
metadata:
  { "openclaw": { "emoji": "\U0001F6A6", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Index Valuation Timer (指数估值定投)

Smart DCA based on index valuation percentile — turn mechanical monthly investing into valuation-driven intelligent allocation. Use **fin_index** for valuation data, **fin_market** for macro context, **fin_data_regime** for market regime overlay.

## When to Use

- "沪深300现在能定投吗" / "should I DCA into CSI 300 now"
- "指数估值分位多少" / "index PE percentile"
- "哪个指数最值得定投" / "which index is best for DCA"
- "沪深300贵不贵" / "is CSI 300 expensive"
- "创业板估值到什么位置了" / "ChiNext valuation level"
- "每月定投5000放哪个指数" / "monthly 5000 RMB which index"
- "股债利差多少" / "equity-bond spread"

## When NOT to Use

- 个股分析/估值/财报 → use `/fin-a-share`
- 龙虎榜/涨停/大宗/融资融券 → use `/fin-a-share-radar`
- 量化选股/五因子筛选 → use `/fin-factor-screen`
- 北向资金流向/外资持仓 → use `/fin-a-northbound-decoder`
- ETF/基金净值/持仓查询 → use `/fin-etf-fund`
- 宏观数据 (GDP/CPI/利率) → use `/fin-macro`
- 期货/期权/可转债 → use `/fin-derivatives`

## Tools & Parameters

### fin_index — 指数估值数据

| Parameter  | Type   | Required | Format             | Default | Example     |
| ---------- | ------ | -------- | ------------------ | ------- | ----------- |
| symbol     | string | Yes      | index code         | —       | 000300.SH   |
| endpoint   | string | Yes      | see endpoint table | —       | daily_basic |
| start_date | string | No       | YYYY-MM-DD         | —       | 2016-01-01  |
| end_date   | string | No       | YYYY-MM-DD         | —       | 2026-03-05  |
| limit      | number | No       | 1-5000             | 200     | 2500        |

### Endpoints

| endpoint           | Description                | Key Params         | Example                                                                                      |
| ------------------ | -------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `daily_basic`      | Index PE/PB/dividend yield | symbol, start_date | `fin_index(symbol="000300.SH", endpoint="daily_basic", start_date="2016-01-01", limit=2500)` |
| `price/historical` | Index daily OHLCV          | symbol, start_date | `fin_index(symbol="000300.SH", endpoint="price/historical", start_date="2026-01-01")`        |
| `constituents`     | Index constituent stocks   | symbol             | `fin_index(symbol="000300.SH", endpoint="constituents")`                                     |

### fin_data_regime — 市场体制 (辅助)

| Parameter | Type | Required | Format | Default | Example             |
| --------- | ---- | -------- | ------ | ------- | ------------------- |
| (none)    | —    | —        | —      | —       | `fin_data_regime()` |

## Key Index Codes

| Index     | Code      | 特征                 |
| --------- | --------- | -------------------- |
| 沪深 300  | 000300.SH | 大盘蓝筹，A 股核心锚 |
| 中证 500  | 000905.SH | 中盘成长，弹性大     |
| 中证 1000 | 000852.SH | 小盘，高波动高弹性   |
| 创业板指  | 399006.SZ | 科技成长，高 PE 正常 |
| 科创 50   | 000688.SH | 硬科技，需 50 万门槛 |
| 上证 50   | 000016.SH | 超大盘，低 PE 低波动 |
| 中证红利  | 000922.SH | 高股息，防御型       |
| 国证 2000 | 399303.SZ | 微盘，流动性风险高   |

## Valuation Analysis Pattern

### Pattern A: 单指数估值诊断 (Single Index Valuation)

1. **获取长期估值** `fin_index(daily_basic, symbol=X, start_date=10年前, limit=2500)` — 拉取 10 年 PE/PB 数据
   - 计算当前 PE(TTM) 在 10 年中的百分位: percentile = count(历史PE < 当前PE) / total
   - 同时计算 PB 百分位
   - ⚠️ 如果 `daily_basic` 返回数据不足 10 年 → 用可用最长区间，注明统计窗口
   - ⚠️ 如果 PE 为负或异常高(>100x) → 可能指数成分大面积亏损，改用 PB 判断

2. **信号灯判定** — 基于 PE 百分位输出投资信号
   - PE 百分位 <20% → 深绿(重仓买入/加倍定投) — 历史性低估
   - PE 百分位 20%-40% → 绿(加倍定投) — 低估区间
   - PE 百分位 40%-60% → 黄(正常定投) — 合理估值
   - PE 百分位 60%-80% → 橙(减半定投) — 偏高估
   - PE 百分位 >80% → 红(暂停定投/考虑减仓) — 高估区间
   - 💡 PB 百分位与 PE 百分位不一致时(如 PE 低但 PB 高)，取两者平均值
   - ⚠️ 创业板/科创板 PE 天然偏高，用各自历史区间比较(不跨指数比)

3. **股债利差** — 估值的绝对参照系
   - EP(盈利收益率) = 1/PE
   - 股债利差 = EP - 10 年期国债收益率(约 2.0-2.5%)
   - ⚠️ 股债利差 >3% → 股票极度便宜(历史底部区域)
   - ⚠️ 股债利差 <0% → 债券更优(历史顶部区域)
   - 💡 A 股 10 年国债收益率当前约 1.7-2.5%，无直接端点时用近期公开值估算

4. **历史回测参照** — 当前分位对应的历史收益
   - PE 在当前分位时，持有 1 年/3 年/5 年的历史中位收益率(经验值)
   - <20% 分位买入 → 3 年中位收益 +50-80%
   - 20-40% 分位买入 → 3 年中位收益 +30-50%
   - 40-60% 分位买入 → 3 年中位收益 +10-25%
   - 60-80% 分位买入 → 3 年中位收益 -5% ~ +15%
   - > 80% 分位买入 → 3 年中位收益 -10% ~ +5%
   - ⚠️ 历史回测不代表未来，但提供概率分布参考

### Pattern B: 多指数横向对比 (Multi-Index Comparison)

1. **批量估值** — 并行调用 `fin_index(daily_basic)` 查询多个指数
   - 推荐对比组: 沪深300 + 中证500 + 创业板指 + 中证红利 + 科创50
   - 计算各自 PE/PB 百分位 + 信号灯

2. **性价比排名** — 按百分位从低到高排序
   - 💡 百分位最低的指数 = 当前性价比最高
   - ⚠️ 不能仅看百分位: 中证1000 百分位低但小盘流动性风险高
   - ⚠️ 中证红利 PE 百分位需谨慎: 高股息股 PE 天然低，看 PB 更有意义

3. **风格判断** — 大盘 vs 小盘 / 价值 vs 成长
   - 沪深300 PE < 中证500 PE (差值缩小) → 大盘更便宜，风格可能切换
   - 💡 结合 `fin_data_regime()` 的 bull/bear/sideways 判断 → 熊市末期小盘弹性大，牛市中期大盘更稳

### Pattern C: 动态定投策略 (Dynamic DCA Strategy)

1. **基础金额设定** — 用户给定月投金额 M
2. **动态调整公式** — 实际投入 = M × (1 + (50% - 当前PE百分位) / 50%)
   - PE 百分位 = 20% → 实际投入 = M × 1.6 (加仓 60%)
   - PE 百分位 = 50% → 实际投入 = M × 1.0 (正常)
   - PE 百分位 = 80% → 实际投入 = M × 0.4 (减仓 60%)
   - PE 百分位 >90% → 暂停定投，考虑赎回部分仓位
   - ⚠️ 动态定投在低估区间多投，高估区间少投，长期收益优于等额定投 20-40%

3. **市场体制叠加** `fin_data_regime()` — 额外确认
   - regime = bear + PE <30% 分位 → 最佳加仓窗口(恐慌时贪婪)
   - regime = bull + PE >70% 分位 → 减仓信号加强
   - 💡 体制检测提供额外信心，但不改变估值信号灯方向

## Signal Quick-Reference

### 信号灯速查表

| PE 百分位 | 信号灯 | 定投建议          | 历史 3 年中位收益 |
| --------- | ------ | ----------------- | ----------------- |
| <20%      | 深绿   | 加倍(2x 基础金额) | +50% ~ +80%       |
| 20%-40%   | 绿     | 加仓(1.2-1.6x)    | +30% ~ +50%       |
| 40%-60%   | 黄     | 正常(1x)          | +10% ~ +25%       |
| 60%-80%   | 橙     | 减半(0.4-0.8x)    | -5% ~ +15%        |
| >80%      | 红     | 暂停/减仓         | -10% ~ +5%        |

### 交叉验证信号

| PE 信号 | PB 信号 | Regime   | 综合判断               |
| ------- | ------- | -------- | ---------------------- |
| 深绿    | 深绿    | bear     | 最强买入(三重共振)     |
| 绿      | 黄      | sideways | 偏低估，正常加仓       |
| 黄      | 橙      | bull     | 合理但偏贵，观察       |
| 红      | 红      | bull     | 过热信号，减仓/暂停    |
| 绿      | 红      | —        | PE/PB 矛盾，用 PB 为主 |

## Data Notes

- **指数估值 (daily_basic)**: Tushare 提供，收盘后 ~18:00 更新，PE 为 TTM (滚动 12 月)
- **PE 统计窗口**: 推荐用 10 年(2500 个交易日)计算百分位; 新指数(如科创50)可用上市以来全部数据
- **分位数精度**: 取决于历史数据量; <3 年数据的指数分位参考性较弱
- **股息率**: `daily_basic` 部分指数返回 `dividend_yield_ratio`，部分需从成分股计算
- **10 年期国债收益率**: DataHub 当前无直接端点，使用近期公开参考值(约 1.7-2.5%)进行股债利差估算
- **市场体制**: `fin_data_regime()` 基于技术面判断 bull/bear/sideways，作为辅助不作为唯一依据
- **指数差异**: 创业板 PE 中枢(~40x)远高于沪深300(~12x)，不可跨指数比较绝对 PE 值

## Response Guidelines

### 数字格式

- PE/PB: 保留 1 位小数，附百分位 (如 "PE 12.8x, 10 年 32% 分位")
- 百分位: 用百分比表示，保留整数 (如 "32% 分位")
- 股息率: 保留 2 位小数 (如 "2.83%")
- 股债利差: 保留 2 位小数 (如 "+1.45%")
- 涨跌幅: +2.35% / -1.08% (始终带 +/- 符号)
- 定投金额: 整百元 (如 "建议月投 6,000 元")

### 必须包含

- 数据截止日期 ("数据截至 2026-03-05")
- PE/PB 百分位的统计窗口 ("近 10 年分位")
- 信号灯结论 (深绿/绿/黄/橙/红)
- 具体定投建议 (金额调整倍数)
- PE 和 PB 双维度 (仅看 PE 不够全面)

### 展示方式

- 单指数诊断 → 一段估值概述 + 信号灯 + 定投建议 + 历史收益参照
- 多指数对比 → 表格 (指数/PE/PE百分位/PB/PB百分位/信号灯/建议)
- 动态定投 → 公式说明 + 当前月份应投金额计算
- 趋势变化 → 最近 PE 百分位变化方向(如 "从上月 45% 降至 32%，信号灯从黄变绿")
