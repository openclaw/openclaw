---
name: fin-risk-monitor
description: "Risk dashboard — multi-market regime detection, interest rate spread, margin risk, foreign capital flow, systemic risk signals. Use when: user asks about market risk, stress testing, or portfolio risk check. NOT for: specific trade decisions."
metadata: { "openclaw": { "emoji": "🚨", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Risk Monitor Dashboard

多维风险监控仪表盘。综合使用 **fin_macro**、**fin_market**、**fin_index**、**fin_data_regime** 工具，构建红/黄/绿三色信号体系，量化系统性风险并给出对冲建议。

## When to Use

- "现在 A 股系统性风险高吗"
- "融资融券风险怎么样"
- "北向资金最近流出多少"
- "利率利差走势如何"
- "市场情绪指标是什么状态"
- "我的组合需要做风险检查"
- "有没有黑天鹅预警信号"

## When NOT to Use

- 个股买卖决策 → use `/fin-equity`
- 大类资产配置 → use `/fin-cross-asset`
- 具体交易策略执行 → use findoo-trader-plugin
- 单纯宏观数据查询 → use `/fin-macro`
- 技术指标计算 → use `/fin-equity` + fin_ta

## 风险信号体系

### 信号等级定义

| 等级 | 颜色 | 含义     | 行动建议           |
| ---- | ---- | -------- | ------------------ |
| G    | 绿色 | 风险可控 | 正常持仓，无需调整 |
| Y    | 黄色 | 风险升温 | 提高警惕，减少杠杆 |
| R    | 红色 | 高风险   | 降低仓位，增加对冲 |

### 综合风险评分

```
综合风险分 = Sum(各维度风险分 x 权重)

0-30 分: [G] 低风险
30-60 分: [Y] 中等风险
60-80 分: [R] 高风险
80-100 分: [R+] 极端风险 (罕见)
```

## 六大风险维度

### 维度 1: 市场体制 (Regime) — 权重 20%

| 指标        | 工具                                                         | [G] 安全 | [Y] 警戒         | [R] 危险      |
| ----------- | ------------------------------------------------------------ | -------- | ---------------- | ------------- |
| Regime 检测 | `fin_data_regime(symbol="000300.SH", market="equity")`       | bull     | sideways         | bear/crisis   |
| 涨跌家数比  | `fin_market(endpoint="discovery/gainers")` vs losers         | > 1.5    | 0.8-1.5          | < 0.8         |
| 涨停/跌停比 | `fin_market(endpoint="market/limit_list")`                   | > 2      | 1-2              | < 1           |
| 成交额变化  | `fin_index(symbol="000300.SH", endpoint="price/historical")` | 0.8-1.5x | 1.5-2.5x / <0.5x | > 2.5x (恐慌) |

### 维度 2: 利率与流动性 — 权重 20%

| 指标              | 工具                                 | [G] 安全 | [Y] 警戒  | [R] 危险          |
| ----------------- | ------------------------------------ | -------- | --------- | ----------------- |
| Shibor O/N        | `fin_macro(endpoint="shibor")`       | < 2.0%   | 2.0%-3.0% | > 3.0%            |
| Shibor 期限结构   | `fin_macro(endpoint="shibor_quote")` | 正常     | 短端偏高  | 倒挂              |
| 期限利差 (10Y-1Y) | `fin_macro(endpoint="treasury_cn")`  | > 50bp   | 20-50bp   | < 20bp (倒挂风险) |
| M2 增速           | `fin_macro(endpoint="money_supply")` | > 10%    | 8%-10%    | < 8%              |

注: DataHub 暂无信用利差 (AA-AAA spread) 数据，该维度用 Shibor 期限结构替代。

### 维度 3: 杠杆风险 — 权重 15%

| 指标              | 工具                                               | [G] 安全  | [Y] 警戒 | [R] 危险      |
| ----------------- | -------------------------------------------------- | --------- | -------- | ------------- |
| 融资余额总量      | `fin_market(endpoint="margin/summary")`            | 稳定      | 快速上升 | 急降 (平仓潮) |
| 融资余额 5 日变化 | `fin_market(endpoint="margin/summary", limit=5)`   | 变化 < 3% | 3%-5%    | > 5% (急降)   |
| 融资交易明细      | `fin_market(endpoint="margin/trading")`            | 正常      | 集中平仓 | 大面积平仓    |
| 质押风险          | `fin_stock(endpoint="pledge/stat")` (抽样高质押股) | < 5%      | 5%-10%   | > 10%         |

### 维度 4: 外资与跨境资金流 — 权重 15%

| 指标             | 工具                                                                        | [G] 安全      | [Y] 警戒       | [R] 危险   |
| ---------------- | --------------------------------------------------------------------------- | ------------- | -------------- | ---------- |
| 北向资金日净买入 | `fin_market(endpoint="flow/hsgt_flow")`                                     | > 0 (净买入)  | -50 ~ 0 亿     | < -50 亿   |
| 北向 5 日累计    | `fin_market(endpoint="flow/hsgt_flow", limit=5)`                            | > 0           | -100 ~ 0 亿    | < -100 亿  |
| 北向前十大活跃股 | `fin_market(endpoint="flow/hsgt_top10")`                                    | 均匀分布      | 集中卖出个别股 | 大面积卖出 |
| 人民币汇率变化   | `fin_macro(endpoint="currency/price/historical", symbol="USDCNH", limit=5)` | 稳定 (< 0.5%) | 单周 > 0.5%    | 单周 > 1%  |

### 维度 5: 宏观经济 — 权重 15%

| 指标       | 工具                                     | [G] 安全 | [Y] 警戒     | [R] 危险           |
| ---------- | ---------------------------------------- | -------- | ------------ | ------------------ |
| 制造业 PMI | `fin_macro(endpoint="pmi")`              | > 51     | 49-51        | < 49               |
| CPI 同比   | `fin_macro(endpoint="cpi")`              | 1%-3%    | 0-1% / 3%-5% | < 0% (通缩) / > 5% |
| PPI 同比   | `fin_macro(endpoint="ppi")`              | 0%-3%    | -3%-0%       | < -3%              |
| 社融增速   | `fin_macro(endpoint="social_financing")` | > 10%    | 8%-10%       | < 8%               |

注: DataHub 暂无美联储利率预期数据，可通过 `fin_macro(endpoint="treasury_us")` 美债收益率变化间接推断。

### 维度 6: 市场情绪 — 权重 15%

| 指标             | 工具                                                         | [G] 安全  | [Y] 警戒        | [R] 危险            |
| ---------------- | ------------------------------------------------------------ | --------- | --------------- | ------------------- |
| 换手率 (沪深300) | `fin_index(symbol="000300.SH", endpoint="price/historical")` | 0.5%-1.5% | 1.5%-3% / <0.3% | > 3% (狂热) / <0.2% |
| 涨停数           | `fin_market(endpoint="market/limit_list")`                   | 30-80     | > 100 (过热)    | < 10 (极冷)         |
| 龙虎榜机构净买   | `fin_market(endpoint="market/top_inst")`                     | 净买入    | 中性            | 净卖出              |
| Regime 状态      | `fin_data_regime(symbol="000300.SH", market="equity")`       | bull      | sideways        | bear/crisis         |

## 风险监控流程

### 每日快速扫描 (3 分钟)

```
Step 1: fin_market(endpoint="flow/hsgt_flow", limit=5)            → 北向资金
Step 2: fin_macro(endpoint="shibor", limit=5)                     → 流动性
Step 3: fin_index(symbol="000300.SH", endpoint="price/historical", limit=5)  → 市场趋势
Step 4: fin_macro(endpoint="currency/price/historical", symbol="USDCNH", limit=5) → 汇率
→ 快速红黄绿判定
```

### 每周深度检查 (10 分钟)

```
Step 1: 六大维度全量数据获取 (并行)
Step 2: 各维度打分 → 加权综合
Step 3: 与上周对比 → 边际变化
Step 4: 异常值标注 + 原因分析
Step 5: 输出风险仪表盘
```

### 突发事件应急检查

```
触发条件: 单日跌幅 > 3% / 成交额异常 / 政策突变
Step 1: 全量风险指标紧急刷新
Step 2: 历史对比 (2015/2018/2020 类似场景)
Step 3: 风险传导链分析
Step 4: 对冲建议 + 行动方案
```

## 风险传导链模型

### 外部冲击传导

```
美联储加息/缩表
    → 美债利率上行 (fin_macro treasury_us)
    → 美元走强
    → 人民币贬值压力 (fin_macro currency/price/historical USDCNH)
    → 北向资金流出 (fin_market flow/hsgt_flow)
    → A 股承压 (尤其外资重仓股)
```

### 内部去杠杆传导

```
监管政策收紧
    → 融资余额下降 (fin_market margin/summary)
    → 杠杆资金平仓
    → 高质押股票风险 (fin_stock pledge/stat)
    → 连锁跌停 / 流动性枯竭
```

### 流动性危机传导

```
银行间利率飙升 (fin_macro shibor)
    → 债券抛售 (流动性变现)
    → 期限利差异常 (fin_macro treasury_cn)
    → 股票抛售 (补保证金)
    → 股债双杀
```

## 对冲建议框架

### 按风险等级

| 风险等级  | 仓位建议     | 对冲工具                 | 现金比例 |
| --------- | ------------ | ------------------------ | -------- |
| [G] 低    | 80-100% 仓位 | 无需对冲                 | 0-20%    |
| [Y] 中等  | 60-80% 仓位  | 买入认沽期权 / 减少杠杆  | 20-40%   |
| [R] 高    | 30-60% 仓位  | 期权保护 + 股指期货空头  | 40-70%   |
| [R+] 极端 | 0-30% 仓位   | 全面对冲 + 增配黄金/国债 | 70-100%  |

### 对冲工具选择

| 工具         | 适用场景     | 成本        | 效率 |
| ------------ | ------------ | ----------- | ---- |
| 股指期货空头 | 系统性风险   | 保证金 ~12% | 高   |
| 认沽期权     | 尾部风险保护 | 期权费 1-3% | 中高 |
| 国债 ETF     | 股债跷跷板   | 几乎无      | 中   |
| 黄金 ETF     | 极端避险     | 几乎无      | 中   |
| 现金         | 万能对冲     | 机会成本    | 低   |

## 历史风险参考场景

| 时间    | 事件            | 综合风险分 | 关键信号                  |
| ------- | --------------- | ---------- | ------------------------- |
| 2015.06 | A 股股灾        | 85         | 融资暴降 + 千股跌停       |
| 2018.10 | 贸易战 + 去杠杆 | 75         | 质押风险 + 北向大幅流出   |
| 2020.03 | COVID 冲击      | 80         | 全球流动性危机 + 股债双杀 |
| 2022.03 | 中概股危机      | 70         | 外资大幅流出 + 汇率贬值   |
| 2024.01 | 小微盘股暴跌    | 65         | 雪球敲入 + 量化平仓连锁   |

## 风险仪表盘输出模板

```
============= 风险仪表盘 =============
日期: YYYY-MM-DD
综合风险分: XX/100 [Y]

维度评分:
  市场体制    [G] 25/100  (regime=bull, 涨跌比正常)
  流动性      [Y] 55/100  (Shibor 小幅上行)
  杠杆风险    [G] 30/100  (融资余额稳定)
  外资流向    [Y] 50/100  (北向小幅流出)
  宏观经济    [Y] 45/100  (PMI 边际走弱)
  市场情绪    [G] 35/100  (换手率正常)

关键变化 (vs 上周):
  ^ 流动性风险 +10 (Shibor O/N 上行 15bp)
  v 市场情绪  -5  (恐慌有所缓解)

行动建议:
  - 维持 70% 仓位
  - 关注 Shibor 走势，若 O/N > 2.5% 减仓
  - 北向资金若连续 3 日大幅流出，启动对冲
==========================================
```

## Response Guidelines

- 风险评分保留整数，标注 [G]/[Y]/[R] 等级
- 每个维度单独评分 + 关键指标数值
- 与上一期对比，标注边际变化方向 (^/v)
- 异常值用加粗标注
- 对冲建议必须具体到工具和比例
- 注明数据截止日期
- 历史参考场景需注明与当前的异同
- 不做具体个股推荐，聚焦系统性风险判断
