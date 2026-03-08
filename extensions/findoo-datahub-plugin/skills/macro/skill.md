---
name: fin-macro
description: "Macroeconomic analysis — China GDP/CPI/PPI/PMI/M2/social financing, interest rates (Shibor/LPR/Libor/Hibor), CN/US treasury yields, FX rates, WorldBank data, economic calendar. DataHub endpoints via fin_macro. Use when: user asks about economic indicators, monetary policy, rate differentials, yield curve, FX trends, or macro cycle positioning. NOT for: individual stocks (use fin-a-share/fin-us-equity/fin-hk-stock), market signals (use fin-a-share-radar), crypto (use fin-crypto)."
metadata: { "openclaw": { "emoji": "🏛️", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Macro & Rates

Use **fin_macro** for macroeconomic indicators and interest rate data via DataHub.

> 美林时钟四象限: Recovery (GDP↑CPI↓) / Overheat (GDP↑CPI↑) / Stagflation (GDP↓CPI↑) / Recession (GDP↓CPI↓)。判定信号详见下方 Macro Cycle Locator。

## fin_macro Parameters

| Parameter  | Type   | Required | Format                                  | Default | Example        |
| ---------- | ------ | -------- | --------------------------------------- | ------- | -------------- |
| endpoint   | string | Yes      | see endpoint tables                     | —       | cpi            |
| symbol     | string | No       | currency pair or indicator              | —       | USDCNH         |
| country    | string | No       | ISO 3166 alpha-2 (CN/US/JP/DE/GB/IN/BR) | —       | CN             |
| indicator  | string | No       | World Bank indicator code               | —       | NY.GDP.MKTP.CD |
| start_date | string | No       | YYYY-MM-DD                              | —       | 2024-01-01     |
| end_date   | string | No       | YYYY-MM-DD                              | —       | 2025-12-31     |
| limit      | number | No       | 1-5000                                  | 200     | 30             |

## Endpoint Map

### China Macro (7)

| endpoint           | Data                 | Freq      |
| ------------------ | -------------------- | --------- |
| `gdp/real`         | China GDP            | Quarterly |
| `cpi`              | Consumer Price Index | Monthly   |
| `ppi`              | Producer Price Index | Monthly   |
| `pmi`              | Purchasing Managers  | Monthly   |
| `money_supply`     | M0/M1/M2             | Monthly   |
| `social_financing` | Social financing     | Monthly   |
| `wz_index`         | Wenzhou private rate | Weekly    |

### Interest Rates (8)

| endpoint       | Data                       | Freq           |
| -------------- | -------------------------- | -------------- |
| `shibor`       | Shanghai Interbank Rate    | Daily          |
| `shibor_quote` | Shibor bank-level quotes   | Daily          |
| `shibor_lpr`   | Loan Prime Rate            | Monthly (20th) |
| `libor`        | London Interbank Rate ⚠️   | Daily          |
| `hibor`        | Hong Kong Interbank Rate   | Daily          |
| `treasury_cn`  | China treasury yields      | Daily          |
| `treasury_us`  | US treasury yields         | Daily          |
| `index_global` | Global index (incl USDCNH) | Daily          |

### FX / Currency (4)

| endpoint                    | Data                | Freq     |
| --------------------------- | ------------------- | -------- |
| `currency/price/historical` | FX historical price | Daily    |
| `currency/search`           | Search pairs        | —        |
| `currency/snapshots`        | FX snapshots        | Intraday |
| `calendar`                  | Economic calendar   | —        |

### World Bank (5)

| endpoint               | Data          | Freq   |
| ---------------------- | ------------- | ------ | ----------------------------------------------- |
| `worldbank/gdp`        | GDP           | Annual |
| `worldbank/population` | Population    | Annual |
| `worldbank/inflation`  | Inflation     | Annual |
| `worldbank/indicator`  | Custom (code) | Annual |
| `worldbank/country`    | 国别基础数据  | —      | 新兴 vs 发达市场分类、人口/面积等 (296 records) |

### Common World Bank Indicator Codes

`NY.GDP.MKTP.CD` GDP (US$) | `NY.GDP.MKTP.KD.ZG` GDP growth % | `FP.CPI.TOTL.ZG` Inflation % | `SL.UEM.TOTL.ZS` Unemployment % | `BX.KLT.DINV.WD.GD.ZS` FDI %

### 固收利率 (fixedincome 专用路径)

`fin_macro(endpoint="fixedincome/rate/shibor")` 等 4 个端点是 `shibor`/`shibor_lpr`/`libor`/`hibor` 的别名路径，返回相同数据。
可用端点: `fixedincome/rate/shibor`, `fixedincome/rate/shibor_lpr`, `fixedincome/rate/libor`, `fixedincome/rate/hibor`。
⚠️ **LIBOR 已于 2023 年正式终止**，DataHub 数据截止 2020-06-24。USD 浮动利率基准已迁移至 SOFR，DataHub 暂无 SOFR 端点。替代方案: 使用 `treasury_us` 短端 (2Y) 作为 USD 利率代理。HIBOR 固收路径同样停在 2020-06，使用 `economy/hibor` 获取更新数据。

## Analysis Patterns

### Macro Cycle Locator

> 美林时钟象限由 GDP 趋势 + CPI 趋势交叉判定，辅以 PMI/社融/M1 领先指标验证。

```
Step 1: fin_macro(endpoint="gdp/real", limit=8)   → GDP trend (8 quarters)
Step 2: fin_macro(endpoint="cpi", limit=12)        → CPI trend (12 months)
```

| Quadrant    | GDP | CPI | Asset priority               |
| ----------- | --- | --- | ---------------------------- |
| Recovery    | up  | dn  | Equity > Bond > Cash > Cmdty |
| Overheat    | up  | up  | Cmdty > Equity > Cash > Bond |
| Stagflation | dn  | up  | Cash > Cmdty > Bond > Equity |
| Recession   | dn  | dn  | Bond > Cash > Equity > Cmdty |

Lead/lag classification: **Leading** (1-3Q): `pmi`, `social_financing`, `money_supply` M1 | **Coincident**: `gdp/real`, `wz_index` | **Lagging**: `cpi`, employment

Auxiliary validation:

- `pmi` — PMI > 50 supports recovery/overheat; new orders sub-index is strongest lead
- `money_supply` — M2 accel = liquidity easing; M1 accel = capital activation
- `social_financing` — credit expansion leads GDP by 2-3 quarters

### Policy Signal Matrix

```
Step 1: fin_macro(endpoint="shibor_lpr", limit=12)
Step 2: fin_macro(endpoint="money_supply", limit=12)
Step 3: fin_macro(endpoint="social_financing", limit=12)
```

| LPR  | M2   | Social Fin | Signal         | Market implication         |
| ---- | ---- | ---------- | -------------- | -------------------------- |
| cut  | rise | surge      | Full easing    | Strong bullish, dual rally |
| cut  | rise | flat       | Targeted       | Structural positive        |
| hold | fall | shrink     | Marginal tight | Caution, funding stress    |
| hike | fall | shrink     | Full tight     | Bearish, leverage pressure |
| hold | flat | flat       | Neutral        | Watch marginal changes     |

Auxiliary signals:

- `shibor_quote` — short > long tenor = liquidity stress (inverted term structure)
- `wz_index` — rising = private lending demand up / formal channels tightening

### CN-US Spread Trade

`treasury_cn`(limit=60) + `treasury_us`(limit=60) + `currency/price/historical`(symbol="USDCNH", limit=60, provider="massive")

> **字段名注意:**
>
> - `treasury_cn` 返回: `yield_value` (收益率) + `curve_term` (期限: 1Y/2Y/5Y/10Y/30Y)
> - `treasury_us` 返回: `y5`/`y7`/`y10`/`y20`/`y30` (各期限收益率，非通用 `yield` 字段)
> - ⚠️ `treasury_us` 数据源待验证 — 部分返回值与中国国债收益率相似 (10Y≈1.80%)，跨境利差计算前请人工校验
> - `currency/price/historical` 需添加 `provider="massive"` 以获取 FX 数据

| 10Y Spread (CN-US) | FX impact        | Positioning                                      |
| ------------------ | ---------------- | ------------------------------------------------ |
| > +50bp            | CNH appreciation | OW CN govies, long CNH, northbound inflow        |
| 0 to -50bp         | Neutral          | Hedge FX, favor exporters (weak CNH beneficiary) |
| < -50bp            | CNH depreciation | UW CN duration, long USD/CNH                     |
| < -100bp           | Strong outflow   | Max UW CN duration, watch PBOC OMO for floor     |

### Shibor Term Structure

`fin_macro(endpoint="shibor_quote")` → O/N < 1W < 1M < 3M = normal; O/N > 1W or 1M > 3M = inverted (liquidity stress)

### Scenario Modeling (3-scenario)

Data inputs: `gdp/real` + `cpi` + `pmi` + `money_supply`

| Dimension | Bull        | Base            | Bear           |
| --------- | ----------- | --------------- | -------------- |
| GDP       | +0.5% above | Trend continues | -0.5% below    |
| CPI       | Mild 2-3%   | Current level   | Deflation < 0% |
| Equity    | +15-20%     | +5-10%          | -10-15%        |
| Bonds 10Y | +20bp       | +/-10bp         | -30bp          |
| Prob      | 25%         | 50%             | 25%            |

Probability adjustment rules (each trigger shifts +10pp):

- Bull: PMI > 51 x3mo | 社融 beat + M2 accel > 0.5pp | LPR cut + M1 inflection up
- Bear: PMI < 49 x2mo + PPI deflation | external shock | CPI > 3% + PBOC net drain

## Data Release Calendar

| Indicator | Release             | Time  |
| --------- | ------------------- | ----- |
| PMI       | 1st of month        | 09:00 |
| CPI/PPI   | 9th-12th            | 09:30 |
| M2/SocFin | 10th-15th           | PM    |
| GDP       | 15th-18th of Q+1 M1 | 10:00 |
| LPR       | 20th                | 09:30 |

## 高级宏观分析

### M1-M2 剪刀差信号

`fin_macro(endpoint="money_supply", limit=24)` → Compute M1_YoY - M2_YoY

| M1-M2 Gap | Signal   | Interpretation                                 |
| --------- | -------- | ---------------------------------------------- |
| > 0       | 资金活化 | Funds flowing to enterprises, bullish equities |
| 0 to -5pp | 中性     | Watch trend direction for inflection           |
| < -5pp    | 资金沉淀 | Stuck in savings, bearish equities             |
| Gap 收窄  | 边际改善 | Equity market bottom forming (1-2Q lead)       |

### CPI-PPI 剪刀差 (利润分配信号)

`fin_macro(endpoint="cpi", limit=12)` + `fin_macro(endpoint="ppi", limit=12)` → CPI_YoY - PPI_YoY

| CPI-PPI Gap  | Sector implication                                         |
| ------------ | ---------------------------------------------------------- |
| PPI > CPI    | Upstream profits expand; midstream/consumer margin squeeze |
| CPI > PPI    | Consumer brands + retail outperform; upstream deflation    |
| Both rising  | Commodity longs, short duration bonds                      |
| Both falling | Long duration bonds, defensive sectors                     |

### 社融-GDP 领先关系 (信贷脉冲)

`fin_macro(endpoint="social_financing", limit=24)` + `fin_macro(endpoint="gdp/real", limit=8)` — 信贷脉冲 = 社融增量的二阶导 (3 月移动平均增速的变化率)，领先 GDP 2-3Q:

- 脉冲转正 (社融增速加速) + PMI > 50 → high confidence GDP recovery ahead
- 脉冲转负 (社融增速减速) + M1 下行 → GDP 下行风险，提前减仓周期股

### HIBOR-LIBOR 利差 (港元联系汇率压力)

`fin_macro(endpoint="hibor", limit=60)` + `fin_macro(endpoint="libor", limit=60)` → match tenor (O/N, 1M, 3M)

| HIBOR-LIBOR         | Implication                                          |
| ------------------- | ---------------------------------------------------- |
| HIBOR > LIBOR +50bp | HKMA draining liquidity, HK equities pressure        |
| HIBOR ≈ LIBOR       | Peg functioning normally                             |
| HIBOR < LIBOR -30bp | Hot money inflows to HK, watch property/equity rally |

### World Bank 跨国对比

`worldbank/gdp` + `worldbank/inflation` (country="CN"/"US"/"JP", limit=10) → 跨国周期对比

- GDP 增速差扩大 → 资金流向高增长经济体
- 通胀差异 → 预判各央行货币政策分化方向

### 经济日历交易策略

**PMI surprise**: `calendar` + `pmi`(limit=6) → actual - prior trend

- surprise > +1.0 → A 股跳涨, 商品走强, 债券承压
- surprise < -1.0 → 避险: 债券走强, A 股承压, 黄金受益

**LPR 传导链**: `shibor_lpr`(limit=12) → LPR 下调 → 房贷利率降 → 地产改善 → 银行 NIM 压 → 消费回升

- -10bp: 地产温和利好, 银行中性偏负 | -20bp+: 地产明确利好, 银行 NIM 压力

**汇率干预识别**: `currency/snapshots` + `currency/price/historical`(symbol="USDCNH", limit=30)

- CNH 单日升值 > 500 pips 且无基本面驱动 → 央行入场
- 中间价连续 3 日强于模型预测 → 逆周期因子启动
- 离岸 CNH 利率骤升 (via `hibor` O/N) → 抽紧离岸流动性打空头

## Data Notes & Output Formatting

- Tushare macro: 1-2h after release, not real-time | World Bank: annual, 6-12 month lag
- Rates (Shibor/Libor/Hibor): daily on trading days | LPR: 20th monthly, deferred on holidays
- `worldbank/indicator`: requires indicator code (see table above)
- `shibor_quote`: per-bank quotes by tenor, for term structure | `wz_index`: shadow banking proxy
- GDP: 6.1% (1 decimal) | CPI/PPI: YoY +2.3% (always label YoY/MoM)
- Rates/Yields: 3 decimals | Money: 万亿元 | FX: 4 decimals | Spread: bp
- Always note data publication date, not query date
- Cycle positioning must state data time window; policy reads add "不构成投资建议"
