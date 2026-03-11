---
name: fin-risk-monitor
description: "Risk monitoring dashboard — market regime detection, rate risk (Shibor/treasury spread), leverage risk (margin), foreign capital flows, macro warning signals. Orchestrates fin_data_regime + fin_macro + fin_market + fin_index. Use when: user asks about market risk assessment, stress signals, risk dashboard, or hedging recommendations. NOT for: trade decisions (use fin-a-share), macro cycle forecasting or positioning (use fin-macro)."
metadata: { "openclaw": { "emoji": "🚨", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Risk Monitor Dashboard

综合使用 **fin_macro**、**fin_market**、**fin_index**、**fin_data_regime** 构建红/黄/绿三色信号体系，量化系统性风险。

## 综合风险评分

```
综合风险分 = Sum(各维度风险分 x 权重)

0-30: [G] 低风险 | 30-60: [Y] 中等风险 | 60-80: [R] 高风险 | 80-100: [R+] 极端风险
```

## 六大风险维度 — Endpoint 映射 + 阈值简表

### 1. 市场体制 (Regime) — 权重 20%

| 指标        | 工具调用                                                                              | [G]      | [Y]            | [R]         |
| ----------- | ------------------------------------------------------------------------------------- | -------- | -------------- | ----------- |
| Regime      | `fin_data_regime(symbol="000300.SH", market="equity")`                                | bull     | sideways       | bear/crisis |
| 全市场快照  | `fin_market(endpoint="market_snapshots")` → 12000+ 记录，快速获取涨跌家数比、成交额等 | —        | —              | —           |
| 涨跌家数比  | `fin_market(endpoint="discovery/gainers")` vs losers                                  | > 1.5    | 0.8-1.5        | < 0.8       |
| 涨停/跌停比 | `fin_market(endpoint="market/limit_list")`                                            | > 2      | 1-2            | < 1         |
| 成交额变化  | `fin_index(symbol="000300.SH", endpoint="price/historical")`                          | 0.8-1.5x | 1.5-2.5x/<0.5x | >2.5x(恐慌) |

### 2. 利率与流动性 — 权重 20%

| 指标             | 工具调用                             | [G]    | [Y]       | [R]    |
| ---------------- | ------------------------------------ | ------ | --------- | ------ |
| Shibor O/N       | `fin_macro(endpoint="shibor")`       | < 2.0% | 2.0%-3.0% | > 3.0% |
| Shibor 期限结构  | `fin_macro(endpoint="shibor_quote")` | 正常   | 短端偏高  | 倒挂   |
| 期限利差(10Y-1Y) | `fin_macro(endpoint="treasury_cn")`  | > 50bp | 20-50bp   | < 20bp |
| M2 增速          | `fin_macro(endpoint="money_supply")` | > 10%  | 8%-10%    | < 8%   |

### 3. 杠杆风险 — 权重 15%

| 指标            | 工具调用                                         | [G]  | [Y]      | [R]          |
| --------------- | ------------------------------------------------ | ---- | -------- | ------------ |
| 融资余额总量    | `fin_market(endpoint="margin/summary")`          | 稳定 | 快速上升 | 急降(平仓潮) |
| 融资余额5日变化 | `fin_market(endpoint="margin/summary", limit=5)` | < 3% | 3%-5%    | > 5%(急降)   |
| 融资交易明细    | `fin_market(endpoint="margin/trading")`          | 正常 | 集中平仓 | 大面积平仓   |
| 质押风险        | `fin_stock(endpoint="pledge/stat")` 抽样         | < 5% | 5%-10%   | > 10%        |

### 4. 外资与跨境资金流 — 权重 15%

| 指标           | 工具调用                                                                    | [G]      | [Y]       | [R]        |
| -------------- | --------------------------------------------------------------------------- | -------- | --------- | ---------- |
| 北向日净买入   | `fin_market(endpoint="flow/hsgt_flow")`                                     | > 0      | -50~0亿   | < -50亿    |
| 北向5日累计    | `fin_market(endpoint="flow/hsgt_flow", limit=5)`                            | > 0      | -100~0亿  | < -100亿   |
| 北向前十活跃股 | `fin_market(endpoint="flow/hsgt_top10")`                                    | 均匀分布 | 集中卖出  | 大面积卖出 |
| 南向月度汇总   | `fin_market(endpoint="flow/ggt_monthly")` — 中长期南向资金趋势              | 稳定流入 | 波动      | 持续流出   |
| 人民币汇率     | `fin_macro(endpoint="currency/price/historical", symbol="USDCNH", limit=5)` | < 0.5%   | > 0.5%/周 | > 1%/周    |

### 5. 宏观经济 — 权重 15%

| 指标      | 工具调用                                 | [G]   | [Y]        | [R]           |
| --------- | ---------------------------------------- | ----- | ---------- | ------------- |
| 制造业PMI | `fin_macro(endpoint="pmi")`              | > 51  | 49-51      | < 49          |
| CPI 同比  | `fin_macro(endpoint="cpi")`              | 1%-3% | 0-1%/3%-5% | <0%(通缩)/>5% |
| PPI 同比  | `fin_macro(endpoint="ppi")`              | 0%-3% | -3%-0%     | < -3%         |
| 社融增速  | `fin_macro(endpoint="social_financing")` | > 10% | 8%-10%     | < 8%          |

### 6. 市场情绪 — 权重 15%

| 指标            | 工具调用                                                     | [G]       | [Y]           | [R]             |
| --------------- | ------------------------------------------------------------ | --------- | ------------- | --------------- |
| 换手率(沪深300) | `fin_index(symbol="000300.SH", endpoint="price/historical")` | 0.5%-1.5% | 1.5%-3%/<0.3% | >3%(狂热)/<0.2% |
| 涨停数          | `fin_market(endpoint="market/limit_list")`                   | 30-80     | > 100(过热)   | < 10(极冷)      |
| 龙虎榜机构净买  | `fin_market(endpoint="market/top_inst")`                     | 净买入    | 中性          | 净卖出          |
| Regime          | `fin_data_regime(symbol="000300.SH", market="equity")`       | bull      | sideways      | bear/crisis     |

## 补充数据源

- `fin_market(endpoint="market_snapshots")` → 全市场实时快照 (12000+ 记录)，可快速获取涨跌家数比、成交额分布等，适合风险扫描的第一步。
- `fin_market(endpoint="flow/ggt_monthly")` → 南向月度汇总，用于中长期南向资金趋势判断。
- **注意**: `flow/ggt_top10` 端点在 DataHub 上超时不可用，南向数据请改用 `flow/ggt_daily` 或 `flow/ggt_monthly`。

## 数据缺口替代方案

### VIX 恐慌指数代理 (Composite Fear Index)

无 CBOE VIX，三源合成: `fin_market(market/limit_list)` 跌停数D + `fin_data_regime(000300.SH)` regime R + `fin_index(000300.SH, price/historical)` 日振幅=(high-low)/close

```
VIX_proxy = 0.3*norm(D) + 0.4*regime_score(R) + 0.3*norm(振幅)
  regime_score: bull=0, sideways=30, volatile=60, bear=75, crisis=100
  norm(D): <10→0, 10-50→25, 50-100→50, 100-200→75, >200→100
  norm(振幅): <1%→0, 1-2%→25, 2-3%→50, 3-5%→75, >5%→100
  阈值: 0-25[G] | 25-55[Y] | 55-80[R] | >80[R+]
```

### 信用风险代理 (Credit Stress Proxy)

无 AA-AAA 利差，三源合成: `fin_macro(shibor)` O/N值+日变化 + `fin_macro(shibor_quote)` 期限结构 + `fin_market(margin/summary)` 融资余额5日变化

```
Credit_stress = 0.4*shibor_score + 0.3*curve_score + 0.3*margin_score
  shibor: O/N<2%→0, 2-3%→30, 3-5%→60, >5%→100; 单日跳升>50bp额外+20
  curve: 正常→0, 平坦化→40, 倒挂→80, 深度倒挂(1W>3M+50bp)→100
  margin: 5日变化<-3%→80(平仓潮), -1~-3%→40, 稳定→0
  阈值: 0-30[G] | 30-60[Y] | 60-85[R] | >85[R+]
```

### 美联储利率预期

`fin_macro(treasury_us)` 10Y-2Y 利差: 走阔→预期降息, 收窄/倒挂→预期加息/衰退, 10Y日变>10bp→重大信号

## 风险传导链模型

| 路径             | 链路                                                                                                  | 频率 | 升级触发     |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ---- | ------------ |
| **A 外部冲击**   | 美债↑(`treasury_us`) → CNH贬(`USDCNH`) → 北向流出(`hsgt_flow`) → 大宗联动(AU/SC) → A股承压            | 日频 | 10Y日变>10bp |
| **B 去杠杆**     | 监管收紧 → 融资降(`margin/summary`) → 杠杆平仓(`margin/trading`) → 质押风险(`pledge/stat`) → 连锁跌停 | 周频 | 融资连降3日  |
| **C 流动性危机** | Shibor飙升(`shibor`) → 债券抛售(`treasury_cn`) → 利差异常 → 股债双杀                                  | 日频 | O/N>3%       |

## 风险情景预案

| 情景             | 触发条件                                           | 行动                                           |
| ---------------- | -------------------------------------------------- | ---------------------------------------------- |
| **A 美联储冲击** | 10Y 5日升>25bp + USDCNH周升>0.8% + 北向3日出>150亿 | 减成长至30%，增配高股息，IF空头对冲            |
| **B 信用事件**   | 融资10日降>8% + O/N>3.5% + 银行地产跌停>15         | 清仓金融地产，仓位<30%，增配国债ETF(511010.SH) |
| **C 地缘冲突**   | AU日涨>2% + SC日涨>5% + USDCNH 3日升>1%            | 仓位30%，加配黄金/现金/短期国债                |
| **D 钱荒**       | O/N>5% + 大面积强平 + 跌停>200 + 10Y-1Y<10bp       | 全清仓转现金。恢复: O/N<2.5% + 跌停<50         |

## 尾部风险预警 (Perfect Storm)

3+维度同时[R]触发: **N=3** 仓位降至40%，`fin_derivatives(futures/historical, IF主力)` 空头 + `options/basic` 认沽 | **N=4** 仓位20%，加配`AU主力`黄金 | **N>=5** 仓位0-10%全现金+国债，等2+维度回[Y]

## 每日快速扫描 Pattern

```
Step 1: fin_market(endpoint="flow/hsgt_flow", limit=5)            → 北向资金
Step 2: fin_macro(endpoint="shibor", limit=5)                     → 流动性
Step 3: fin_index(symbol="000300.SH", endpoint="price/historical", limit=5)  → 市场趋势
Step 4: fin_macro(endpoint="currency/price/historical", symbol="USDCNH", limit=5) → 汇率
→ 快速红黄绿判定

AUTO-ESCALATION (任一Step返回[R]):
  Step 5: fin_data_regime(000300.SH) → 体制  Step 6: margin/summary → 杠杆
  Step 7: market/limit_list → VIX代理  Step 8: shibor_quote → 信用代理
  Step 9: pmi → 宏观前瞻 → 综合评分 → 匹配情景预案
```

**每周深度检查:** 六维度全量并行获取 → 加权打分+VIX_proxy/Credit_stress → 与上周对比边际变化 → 输出仪表盘

## 对冲建议框架

| 风险等级  | 仓位建议 | 对冲工具                                                  | 现金比例 |
| --------- | -------- | --------------------------------------------------------- | -------- |
| [G] 低    | 80-100%  | 无需对冲                                                  | 0-20%    |
| [Y] 中等  | 60-80%   | `fin_derivatives(options/basic)` 认沽 / 减杠杆            | 20-40%   |
| [R] 高    | 30-60%   | `fin_derivatives(futures/historical, IF主力)` 空头 + 认沽 | 40-70%   |
| [R+] 极端 | 0-30%    | 全面对冲 + `AU主力` 黄金 + 国债ETF                        | 70-100%  |

## 输出模板

```
============= 风险仪表盘 =============
日期: YYYY-MM-DD | 综合风险分: XX/100 [Y]
维度: 体制[G]25 流动性[Y]55 杠杆[G]30 外资[Y]50 宏观[Y]45 情绪[G]35
代理: VIX_proxy XX[G/Y/R] | Credit_stress XX[G/Y/R]
变化(vs上周): ^流动性+10 | v情绪-5
情景: 无/A预警/D触发 | 尾部: N/6维度[R]
行动建议: (工具+比例，注明数据截止日)
==========================================
```
