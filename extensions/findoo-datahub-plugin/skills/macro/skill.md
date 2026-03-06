---
name: fin-macro
description: "Macro economics & rates — China GDP/CPI/PPI/PMI/M2, global rates (Shibor/LPR/Libor/Treasury), Shibor quote term structure, Wenzhou index, FX (USDCNH), World Bank data. Includes Merrill Lynch clock cycle locator, policy signal interpreter, China-US spread trade analysis, and scenario modeling. Use when: user asks about economic indicators, interest rates, FX, or cross-country macro comparison. NOT for: stocks (use fin-equity), crypto (use fin-crypto-defi), derivatives (use fin-derivatives)."
metadata: { "openclaw": { "emoji": "🏛️", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Macro & Rates

Use **fin_macro** for macroeconomic indicators and interest rate data via DataHub (works out of the box).

> 参考知识库: `references/macro-cycle-cn.md`

## When to Use

- "中国最新 GDP" / "China GDP growth"
- "CPI 数据" / "latest CPI"
- "Shibor 利率" / "interbank rate"
- "Shibor 报价期限结构" / "Shibor quote term structure"
- "LPR 是多少" / "loan prime rate"
- "美国国债收益率" / "US Treasury yield"
- "中美 GDP 对比" / "World Bank comparison"
- "社融数据" / "social financing"
- "M2 增速" / "money supply growth"
- "人民币汇率" / "USDCNH exchange rate"
- "温州指数" / "Wenzhou private lending rate"
- "当前经济周期在哪" / "Merrill Lynch clock"

## When NOT to Use

- 个股行情/财报/ETF → use `/fin-equity`
- 加密货币/DeFi → use `/fin-crypto-defi`
- 期货/期权/可转债 → use `/fin-derivatives`
- 龙虎榜/涨停/北向资金 → use `/fin-market-radar`
- 172 endpoint 通用查询 → use `/fin-data-query`

## Tools & Parameters

### fin_macro

| Parameter  | Type   | Required | Format                                  | Default | Example        |
| ---------- | ------ | -------- | --------------------------------------- | ------- | -------------- |
| endpoint   | string | Yes      | see endpoint tables                     | —       | cpi            |
| symbol     | string | No       | currency pair or indicator              | —       | USDCNH         |
| country    | string | No       | ISO 3166 alpha-2 (CN/US/JP/DE/GB/IN/BR) | —       | CN             |
| indicator  | string | No       | World Bank indicator code               | —       | NY.GDP.MKTP.CD |
| start_date | string | No       | YYYY-MM-DD                              | —       | 2024-01-01     |
| end_date   | string | No       | YYYY-MM-DD                              | —       | 2025-12-31     |
| limit      | number | No       | 1-5000                                  | 200     | 30             |

## China Macro (7 endpoints)

| endpoint           | Description           | Frequency | Example                                  |
| ------------------ | --------------------- | --------- | ---------------------------------------- |
| `gdp/real`         | China GDP             | Quarterly | `fin_macro(endpoint="gdp/real")`         |
| `cpi`              | Consumer Price Index  | Monthly   | `fin_macro(endpoint="cpi")`              |
| `ppi`              | Producer Price Index  | Monthly   | `fin_macro(endpoint="ppi")`              |
| `pmi`              | Purchasing Managers   | Monthly   | `fin_macro(endpoint="pmi")`              |
| `money_supply`     | Money supply M0/M1/M2 | Monthly   | `fin_macro(endpoint="money_supply")`     |
| `social_financing` | Social financing      | Monthly   | `fin_macro(endpoint="social_financing")` |
| `wz_index`         | 温州民间借贷利率指数  | Weekly    | `fin_macro(endpoint="wz_index")`         |

## Interest Rates (8 endpoints)

| endpoint       | Description                  | Frequency      | Example                              |
| -------------- | ---------------------------- | -------------- | ------------------------------------ |
| `shibor`       | Shanghai Interbank Rate      | Daily          | `fin_macro(endpoint="shibor")`       |
| `shibor_quote` | Shibor 报价行明细 (期限结构) | Daily          | `fin_macro(endpoint="shibor_quote")` |
| `shibor_lpr`   | Loan Prime Rate              | Monthly (20th) | `fin_macro(endpoint="shibor_lpr")`   |
| `libor`        | London Interbank Rate        | Daily          | `fin_macro(endpoint="libor")`        |
| `hibor`        | Hong Kong Interbank Rate     | Daily          | `fin_macro(endpoint="hibor")`        |
| `treasury_cn`  | China treasury yields        | Daily          | `fin_macro(endpoint="treasury_cn")`  |
| `treasury_us`  | US treasury yields           | Daily          | `fin_macro(endpoint="treasury_us")`  |
| `wz_index`     | (see China Macro above)      | Weekly         | —                                    |

## FX / Currency (4 endpoints)

| endpoint                    | Description            | Frequency | Example                                                            |
| --------------------------- | ---------------------- | --------- | ------------------------------------------------------------------ |
| `currency/price/historical` | FX historical price    | Daily     | `fin_macro(endpoint="currency/price/historical", symbol="USDCNH")` |
| `currency/search`           | Search currency pairs  | —         | `fin_macro(endpoint="currency/search", symbol="CNH")`              |
| `currency/snapshots`        | FX real-time snapshots | Intraday  | `fin_macro(endpoint="currency/snapshots")`                         |
| `currency/news`             | FX related news        | —         | `fin_macro(endpoint="currency/news")`                              |

## Global (World Bank) (4 endpoints)

| endpoint               | Description           | Frequency | Example                                                                               |
| ---------------------- | --------------------- | --------- | ------------------------------------------------------------------------------------- |
| `worldbank/gdp`        | World Bank GDP        | Annual    | `fin_macro(endpoint="worldbank/gdp", country="CN")`                                   |
| `worldbank/population` | World Bank population | Annual    | `fin_macro(endpoint="worldbank/population", country="US")`                            |
| `worldbank/inflation`  | World Bank inflation  | Annual    | `fin_macro(endpoint="worldbank/inflation", country="CN")`                             |
| `worldbank/indicator`  | Custom WB indicator   | Annual    | `fin_macro(endpoint="worldbank/indicator", country="CN", indicator="NY.GDP.MKTP.CD")` |

**Total: 23 endpoints** (7 China Macro + 8 Interest Rates + 4 FX + 4 World Bank)

### 常用 World Bank Indicator Codes

| Code                   | Description                              |
| ---------------------- | ---------------------------------------- |
| `NY.GDP.MKTP.CD`       | GDP (current US$)                        |
| `NY.GDP.MKTP.KD.ZG`    | GDP growth (annual %)                    |
| `FP.CPI.TOTL.ZG`       | Inflation, consumer prices (annual %)    |
| `SL.UEM.TOTL.ZS`       | Unemployment (% of total labor force)    |
| `BX.KLT.DINV.WD.GD.ZS` | FDI, net inflows (% of GDP)              |
| `NE.EXP.GNFS.ZS`       | Exports of goods and services (% of GDP) |

## Macro Cycle Locator (美林时钟)

使用 GDP + CPI 数据确定当前经济周期所处象限：

```
Step 1: fin_macro(gdp/real, limit=8)  → 近 8 季度 GDP 增速趋势
Step 2: fin_macro(cpi, limit=12)      → 近 12 月 CPI 同比趋势
```

**四象限判断:**

| 象限             | GDP 趋势 | CPI 趋势 | 资产配置优先级            |
| ---------------- | -------- | -------- | ------------------------- |
| 复苏 Recovery    | 上行 ↑   | 下行 ↓   | 股票 > 债券 > 现金 > 商品 |
| 过热 Overheat    | 上行 ↑   | 上行 ↑   | 商品 > 股票 > 现金 > 债券 |
| 滞胀 Stagflation | 下行 ↓   | 上行 ↑   | 现金 > 商品 > 债券 > 股票 |
| 衰退 Recession   | 下行 ↓   | 下行 ↓   | 债券 > 现金 > 股票 > 商品 |

**判断流程:**

```
GDP 增速趋势 (近 4 季环比)
├─ 上行 + CPI 下行 → 复苏期: 加权配置股票
├─ 上行 + CPI 上行 → 过热期: 商品/周期股
├─ 下行 + CPI 上行 → 滞胀期: 防御/现金
└─ 下行 + CPI 下行 → 衰退期: 债券/国债
```

辅助验证:

- `fin_macro(pmi)` — PMI > 50 支持复苏/过热判断
- `fin_macro(money_supply)` — M2 加速增长暗示流动性宽松
- `fin_macro(social_financing)` — 社融放量验证信用扩张

## Policy Signal Interpreter (政策信号解读器)

综合 LPR + M2 + 社融判断政策方向：

```
Step 1: fin_macro(shibor_lpr, limit=12)      → LPR 近 12 月变动
Step 2: fin_macro(money_supply, limit=12)     → M2 增速趋势
Step 3: fin_macro(social_financing, limit=12) → 社融规模趋势
```

**政策信号矩阵:**

| LPR  | M2 增速 | 社融 | 政策判断 | 市场含义                   |
| ---- | ------- | ---- | -------- | -------------------------- |
| 下调 | 上升    | 放量 | 全面宽松 | 强利好，股债双牛可能       |
| 下调 | 上升    | 平稳 | 定向宽松 | 结构性利好，流动性改善     |
| 不变 | 下降    | 收缩 | 边际收紧 | 谨慎，关注资金面紧张       |
| 上调 | 下降    | 收缩 | 全面紧缩 | 利空，高杠杆行业承压       |
| 不变 | 平稳    | 平稳 | 中性观望 | 维持现状，关注数据边际变化 |

**辅助信号:**

- `fin_macro(shibor_quote)` → Shibor 报价期限结构：短端利率 > 长端 = 流动性紧张
- `fin_macro(wz_index)` → 温州指数上行 = 民间融资需求旺盛 / 正规渠道收紧

## China-US Interest Rate Spread Trade (中美利差策略)

```
Step 1: fin_macro(treasury_cn, limit=60) → 中国国债收益率 (10Y)
Step 2: fin_macro(treasury_us, limit=60) → 美国国债收益率 (10Y)
Step 3: fin_macro(currency/price/historical, symbol="USDCNH", limit=60) → 人民币汇率
```

**利差-汇率联动分析:**

| 中美10Y利差      | 汇率影响           | 策略含义                         |
| ---------------- | ------------------ | -------------------------------- |
| 利差 > 0 (中>美) | 人民币升值压力     | 外资流入中国债市，北向资金偏积极 |
| 利差 = 0 (均衡)  | 汇率受其他因素主导 | 关注贸易差额和资本管制政策       |
| 利差 < 0 (中<美) | 人民币贬值压力     | 资本外流风险，出口企业受益       |
| 利差快速收窄     | 趋势反转信号       | 关注央行干预意愿和美联储动向     |

**Shibor 期限结构分析:**

```
fin_macro(shibor_quote) → 各期限报价
  O/N < 1W < 2W < 1M < 3M → 正常期限结构
  O/N > 1W or 1M > 3M → 倒挂，流动性紧张信号
```

## Scenario Modeling Approach (情景分析)

对重大宏观事件进行三情景建模：

```
基于当前数据:
fin_macro(gdp/real) + fin_macro(cpi) + fin_macro(pmi) + fin_macro(money_supply)

构建三种情景:
┌────────────┬─────────────────┬─────────────────┬─────────────────┐
│            │ 乐观 (Bull)     │ 基准 (Base)     │ 悲观 (Bear)     │
├────────────┼─────────────────┼─────────────────┼─────────────────┤
│ GDP 增速   │ 当前值 +0.5%    │ 当前趋势延续    │ 当前值 -0.5%    │
│ CPI        │ 温和上行 2-3%   │ 维持当前水平    │ 通缩 < 0%       │
│ 政策       │ 进一步宽松      │ 维持现状        │ 被迫紧缩        │
│ 股市       │ +15-20%         │ +5-10%          │ -10-15%         │
│ 债市       │ 10Y 上行 20bp   │ 10Y 波动 ±10bp  │ 10Y 下行 30bp   │
│ 汇率       │ CNH 升值 2-3%   │ 窄幅波动        │ CNH 贬值 3-5%   │
│ 概率       │ 25%             │ 50%             │ 25%             │
└────────────┴─────────────────┴─────────────────┴─────────────────┘
```

概率赋值依据:

- PMI > 51 连续 3 月 → 乐观概率上调
- 社融超预期 + M2 加速 → 乐观概率上调
- PMI < 49 + 出口下滑 → 悲观概率上调
- 外部冲击 (贸易摩擦/地缘) → 悲观概率上调

## Cross-Country Comparison Pattern

1. `fin_macro(worldbank/gdp, country="CN")` vs `country="US"` — GDP 体量对比
2. `fin_macro(worldbank/inflation, country="CN")` vs `country="US"` — 通胀差异
3. `fin_macro(treasury_cn)` vs `fin_macro(treasury_us)` — 中美利差
   - 中美利差为负 → 资本外流压力，人民币贬值风险
4. `fin_macro(currency/price/historical, symbol="USDCNH")` — 汇率趋势验证

## Data Release Calendar

| Indicator | Release             | Time  |
| --------- | ------------------- | ----- |
| PMI       | 每月 1 日           | 09:00 |
| CPI/PPI   | 每月 9-12 日        | 09:30 |
| M2/社融   | 每月 10-15 日       | 下午  |
| GDP       | 每季度首月 15-18 日 | 10:00 |
| LPR       | 每月 20 日          | 09:30 |

## Data Notes

- **Tushare 宏观数据**: 发布后 1-2 小时入库，非实时
- **World Bank**: 年度数据，通常滞后 6-12 个月
- **利率数据**: 交易日更新，Shibor/Libor/Hibor 为日频
- **LPR**: 每月 20 日固定发布，如遇节假日顺延
- **worldbank/indicator 端点**: 需要用户提供具体 indicator code，建议先查上方常用代码表
- **shibor_quote**: 包含各报价行的分期限报价明细，可分析期限结构
- **wz_index**: 温州民间借贷综合利率，反映民间融资成本，是影子银行的代理指标
- **currency 数据**: FX 历史数据为日频，搜索和快照可用于发现交易对

## Response Guidelines

- GDP 增速: 6.1%（保留 1 位小数）
- CPI/PPI: 同比 +2.3%（始终标注"同比"或"环比"）
- 利率: 3.450%（保留 3 位小数，与官方发布一致）
- 国债收益率: 2.685%（保留 3 位小数）
- 货币量: 万亿元为单位（如 "M2 余额 310.48 万亿元"）
- 汇率: USDCNH 保留 4 位小数 (如 7.2415)
- 利差: 用 bp 表示 (如 "中美 10Y 利差 -85bp")
- 美林时钟判断必须标注所用数据的时间窗口
- 情景分析必须标注概率分配依据
- 必须注明数据发布日期（不是查询日期）
- 趋势描述用 "上行/下行/持平/拐点" 等专业用语
- 涉及政策解读时注明"以上为数据解读，不构成投资建议"
