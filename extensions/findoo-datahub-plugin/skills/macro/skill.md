---
name: fin-macro
description: "Macro economics & rates — China GDP/CPI/PPI/PMI/M2, global rates (Shibor/LPR/Libor/Treasury), World Bank data, FX. Use when: user asks about economic indicators, interest rates, or cross-country macro comparison. NOT for: stocks (use fin-equity), crypto (use fin-crypto-defi), derivatives (use fin-derivatives)."
metadata: { "openclaw": { "emoji": "🏛️", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Macro & Rates

Use **fin_macro** for macroeconomic indicators and interest rate data via DataHub (works out of the box).

## When to Use

- "中国最新 GDP" / "China GDP growth"
- "CPI 数据" / "latest CPI"
- "Shibor 利率" / "interbank rate"
- "LPR 是多少" / "loan prime rate"
- "美国国债收益率" / "US Treasury yield"
- "中美 GDP 对比" / "World Bank comparison"
- "社融数据" / "social financing"
- "M2 增速" / "money supply growth"

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

## China Macro

| endpoint           | Description           | Frequency | Example                                  |
| ------------------ | --------------------- | --------- | ---------------------------------------- |
| `gdp/real`         | China GDP             | Quarterly | `fin_macro(endpoint="gdp/real")`         |
| `cpi`              | Consumer Price Index  | Monthly   | `fin_macro(endpoint="cpi")`              |
| `ppi`              | Producer Price Index  | Monthly   | `fin_macro(endpoint="ppi")`              |
| `pmi`              | Purchasing Managers   | Monthly   | `fin_macro(endpoint="pmi")`              |
| `money_supply`     | Money supply M0/M1/M2 | Monthly   | `fin_macro(endpoint="money_supply")`     |
| `social_financing` | Social financing      | Monthly   | `fin_macro(endpoint="social_financing")` |

## Interest Rates

| endpoint      | Description              | Frequency      | Example                             |
| ------------- | ------------------------ | -------------- | ----------------------------------- |
| `shibor`      | Shanghai Interbank Rate  | Daily          | `fin_macro(endpoint="shibor")`      |
| `shibor_lpr`  | Loan Prime Rate          | Monthly (20th) | `fin_macro(endpoint="shibor_lpr")`  |
| `libor`       | London Interbank Rate    | Daily          | `fin_macro(endpoint="libor")`       |
| `hibor`       | Hong Kong Interbank Rate | Daily          | `fin_macro(endpoint="hibor")`       |
| `treasury_cn` | China treasury yields    | Daily          | `fin_macro(endpoint="treasury_cn")` |
| `treasury_us` | US treasury yields       | Daily          | `fin_macro(endpoint="treasury_us")` |

## Global (World Bank)

| endpoint               | Description           | Frequency | Example                                                                               |
| ---------------------- | --------------------- | --------- | ------------------------------------------------------------------------------------- |
| `worldbank/gdp`        | World Bank GDP        | Annual    | `fin_macro(endpoint="worldbank/gdp", country="CN")`                                   |
| `worldbank/population` | World Bank population | Annual    | `fin_macro(endpoint="worldbank/population", country="US")`                            |
| `worldbank/inflation`  | World Bank inflation  | Annual    | `fin_macro(endpoint="worldbank/inflation", country="CN")`                             |
| `worldbank/indicator`  | Custom WB indicator   | Annual    | `fin_macro(endpoint="worldbank/indicator", country="CN", indicator="NY.GDP.MKTP.CD")` |

### 常用 World Bank Indicator Codes

| Code                   | Description                              |
| ---------------------- | ---------------------------------------- |
| `NY.GDP.MKTP.CD`       | GDP (current US$)                        |
| `NY.GDP.MKTP.KD.ZG`    | GDP growth (annual %)                    |
| `FP.CPI.TOTL.ZG`       | Inflation, consumer prices (annual %)    |
| `SL.UEM.TOTL.ZS`       | Unemployment (% of total labor force)    |
| `BX.KLT.DINV.WD.GD.ZS` | FDI, net inflows (% of GDP)              |
| `NE.EXP.GNFS.ZS`       | Exports of goods and services (% of GDP) |

## Macro Cycle Analysis Pattern

1. **增长趋势** `fin_macro(gdp/real)` — GDP 季度同比
   - ⚠️ 如果连续 2 季度 GDP 增速下行 → 经济放缓信号
2. **通胀压力** `fin_macro(cpi)` + `fin_macro(ppi)` — CPI 和 PPI 剪刀差
   - 💡 PPI 上行 + CPI 平稳 = 企业成本上升但无法传导，利润承压
   - 💡 CPI > 3% → 央行可能收紧货币政策
3. **制造业景气** `fin_macro(pmi)` — PMI 荣枯线 50
   - ⚠️ PMI < 50 连续 3 个月 → 制造业收缩
4. **流动性** `fin_macro(money_supply)` — M2 增速
   - 💡 M2 增速 - GDP 增速 = 超额流动性（> 5% 有利于资产价格）
5. **政策信号** `fin_macro(shibor_lpr)` — LPR 变动
   - ⚠️ LPR 下调 → 宽松周期，利好权益和房地产
   - ⚠️ LPR 上调 → 紧缩周期，债券和高杠杆行业承压
6. **债市信号** `fin_macro(treasury_cn)` — 国债收益率曲线
   - 💡 10Y-2Y 利差收窄 → 经济悲观预期
   - 💡 与美债 `fin_macro(treasury_us)` 对比 → 中美利差影响资本流动

## Cross-Country Comparison Pattern

1. `fin_macro(worldbank/gdp, country="CN")` vs `country="US"` — GDP 体量对比
2. `fin_macro(worldbank/inflation, country="CN")` vs `country="US"` — 通胀差异
3. `fin_macro(treasury_cn)` vs `fin_macro(treasury_us)` — 中美利差
   - 💡 中美利差为负 → 资本外流压力，人民币贬值风险

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

## Response Guidelines

- GDP 增速: 6.1%（保留 1 位小数）
- CPI/PPI: 同比 +2.3%（始终标注"同比"或"环比"）
- 利率: 3.450%（保留 3 位小数，与官方发布一致）
- 国债收益率: 2.685%（保留 3 位小数）
- 货币量: 万亿元为单位（如 "M2 余额 310.48 万亿元"）
- 必须注明数据发布日期（不是查询日期）
- 趋势描述用 "上行/下行/持平/拐点" 等专业用语
- 涉及政策解读时注明"以上为数据解读，不构成投资建议"
