---
name: fin-a-share
description: "A-share stock deep analysis — CAS fundamentals (income/balance/cash/ratios), chip structure (shareholders/pledge/lock-up/repurchase), policy-driven sector rotation, capital flow cross-validation (institutional+retail+northbound). Covers fin_stock, fin_market, fin_index, fin_ta endpoints for individual A-share research. Use when: user mentions A-share codes (600xxx.SH/000xxx.SZ/300xxx.SZ), Chinese company names, or asks about A-share specific analysis. NOT for: US stocks (use fin-us-equity), HK stocks (use fin-hk-stock), crypto (use fin-crypto), market-wide overview without specific stock (use fin-a-share-radar), ETF/funds (use fin-etf-fund)."
metadata:
  {
    "openclaw":
      { "emoji": "\U0001F1E8\U0001F1F3", "requires": { "extensions": ["findoo-datahub-plugin"] } },
  }
---

# A-Share Deep Analysis

Use **fin_stock**, **fin_market**, **fin_index**, **fin_ta** for A-share individual stock research. All data via DataHub, provider = tushare (primary).

## Symbol Format

| Board         | Pattern     | Example                     |
| ------------- | ----------- | --------------------------- |
| Shanghai Main | `600xxx.SH` | 600519.SH (Kweichow Moutai) |
| Shenzhen Main | `000xxx.SZ` | 000001.SZ (Ping An Bank)    |
| ChiNext       | `300xxx.SZ` | 300750.SZ (CATL)            |
| STAR Market   | `688xxx.SH` | 688981.SH (SMIC)            |
| Beijing SE    | `8xxxxx.BJ` | 830799.BJ                   |

## fin_stock Endpoints (A-share: 20, excludes hk/income, us/income)

| endpoint                        | data                    | use case                            |
| ------------------------------- | ----------------------- | ----------------------------------- |
| `price/historical`              | OHLCV                   | price trend, technical overlay      |
| `profile`                       | company overview        | sector, listing date, main business |
| `fundamental/income`            | income statement        | revenue/profit trend, YoY           |
| `fundamental/balance`           | balance sheet           | asset quality, leverage, goodwill   |
| `fundamental/cash`              | cash flow               | OCF vs NI quality check             |
| `fundamental/ratios`            | PE/PB/ROE/margins       | valuation, DuPont                   |
| `fundamental/metrics`           | EV/EBITDA/pe_deducted   | cross-method valuation              |
| `fundamental/dividends`         | dividend history        | DDM input, yield                    |
| `fundamental/adj_factor`        | adjust factor           | ex-rights price                     |
| `fundamental/earnings_forecast` | analyst consensus       | PEG, expectation gap                |
| `ownership/top10_holders`       | top 10 shareholders     | concentration                       |
| `ownership/shareholder_trade`   | insider buy/sell        | smart money signal                  |
| `ownership/repurchase`          | buyback records         | management confidence               |
| `ownership/share_float`         | float structure         | lock-up pressure                    |
| `ownership/holder_number`       | shareholder count       | chip concentration                  |
| `pledge/stat`                   | equity pledge           | pledge risk tiers                   |
| `moneyflow/individual`          | capital flow            | institutional vs retail             |
| `market/top_list`               | dragon-tiger list       | unusual activity                    |
| `discovery/gainers`             | top gainers (no symbol) | market scan                         |
| `discovery/losers`              | top losers (no symbol)  | market scan                         |

**VIP 端点:** `fundamental/balance_vip`、`income_vip`、`cashflow_vip`、`revenue_segment_vip` 提供更细粒度的财务数据（tushare VIP），用于深度财报分析时替代标准版。

## fin_index Endpoints (A-share relevant)

| endpoint              | data                | use case                    |
| --------------------- | ------------------- | --------------------------- |
| `constituents`        | index members       | sector exposure check       |
| `daily_basic`         | index PE/PB         | sector valuation percentile |
| `thematic/ths_index`  | THS concept list    | policy/sector rotation scan |
| `thematic/ths_daily`  | THS concept daily   | concept momentum tracking   |
| `thematic/ths_member` | THS concept members | theme stock list            |

## fin_market Endpoints (individual stock relevant)

| endpoint                | data                  | use case                   |
| ----------------------- | --------------------- | -------------------------- |
| `moneyflow/individual`  | main force net flow   | institutional accumulation |
| `moneyflow/industry`    | sector flow           | rotation signal            |
| `moneyflow/block_trade` | block trades          | large lot detection        |
| `market/top_list`       | dragon-tiger list     | unusual volume cause       |
| `market/top_inst`       | institutional seats   | who is trading             |
| `market/limit_list`     | limit-up/down stats   | sentiment gauge            |
| `flow/hsgt_top10`       | northbound top 10     | foreign holdings delta     |
| `flow/hsgt_flow`        | northbound daily flow | macro foreign sentiment    |
| `margin/detail`         | margin by stock       | leveraged positioning      |

## Provider Path

A-share: **tushare** (primary, most complete). Data updates ~18:00 CST after close.

## Decision Trees

```
user question about A-share stock
├─ valuation / "worth buying?" → Valuation Tree
├─ earnings / financial quality → Earnings Quality Tree
├─ shareholders / chip structure → Chip Analysis Tree
├─ sector / policy / concept → Policy-Driven Analysis Tree
├─ capital flow / who is buying → Capital Flow Cross-Validation Tree
└─ technical / price / volume → Price-Volume Tree
```

### Valuation Tree (A-share adapted)

```
Step 1: fin_stock(fundamental/ratios) → dt_eps (扣非EPS)
  → PE_deducted = price / dt_eps (手动计算，fundamental/metrics 对 A 股返回 204)
  ├─ pe_deducted < sector 50th pctl
  │   ├─ ROE>15% + OCF/NI>0.8 → undervalued candidate
  │   └─ ROE<8% or OCF/NI<0.5 → value trap warning
  ├─ pe_deducted 50th-80th pctl → check growth
  │   └─ fin_stock(fundamental/earnings_forecast) → PEG
  │       ├─ PEG<1 → growth undervalued
  │       └─ PEG>2 → overpriced for growth
  ├─ pe_deducted > 80th pctl → premium validation
  │   ├─ industry leader + moat + growth>30% → justified
  │   └─ no moat → overvalued risk
  └─ Loss-making (PE meaningless) → alt metrics
      ├─ PB<1 + quality assets → net-net
      └─ PS<sector + revenue growth>50% → growth-stage loss
```

**A-share valuation specifics:**

- Shell value: post-registration-reform ~5-15B RMB; deduct from small-cap EV
- Non-recurring: compare `deducted_net_income` vs `net_income`; gap >20% = flag
- Subsidies: NEV/chip sectors heavy — value on post-subsidy earnings
- A-share premium factors: scarcity (10-30%), liquidity (5-15%), policy (variable), northbound repricing
- CAS vs IFRS: AH dual-listed may diverge (see Chip Analysis section below for A-share specifics)

### Earnings Quality Tree

```
Step 1: fin_stock(fundamental/income, limit=8) → 8 quarters
  ├─ NI growth >= revenue growth → margin expansion
  │   └─ fin_stock(fundamental/cash)
  │       ├─ OCF/NI > 0.8 → high quality
  │       └─ OCF/NI < 0.5 → accrual-driven, paper profit
  └─ NI growth < revenue growth → margin squeeze
      └─ fin_stock(fundamental/ratios)
          ├─ gross margin down 2Q → cost pressure
          └─ SGA ratio up → efficiency decline

Step 2: fin_stock(fundamental/earnings_forecast)
  ├─ actual > consensus → positive surprise cycle
  └─ consecutive miss → downward revision, avoid
```

### Chip Analysis Tree (A-share core — 6 steps)

```
Step 1: fin_stock(ownership/top10_holders) → concentration %
  ├─ top10 > 70% → highly concentrated (watch lock-up)
  └─ top10 < 30% → dispersed (retail-driven, high vol)

Step 2: fin_stock(ownership/shareholder_trade) → insider direction
  ├─ net buy (especially exec) → bullish insider confidence
  ├─ net sell + large ratio → distribution warning
  └─ planned buy announcement → short-term positive

Step 3: fin_stock(ownership/repurchase) → buyback
  ├─ cancellation buyback → strongest signal (share count reduction)
  ├─ treasury stock buyback → neutral-positive
  └─ no buyback → no signal

Step 4: fin_stock(pledge/stat) → pledge risk
  ├─ <20% → normal
  ├─ 20-50% → elevated watch (monitor price vs margin call)
  └─ >50% → high risk, margin call zone if price drops 20-30%

Step 5: fin_stock(ownership/holder_number) → trend (quarterly)
  ├─ count declining 2+ quarters → chip concentration (accumulation)
  └─ count rising 2+ quarters → distribution phase

Step 6: fin_stock(ownership/share_float) → lock-up schedule
  └─ large unlock within 3 months → selling pressure expected
```

**Composite signal matrix:**

| buy signal                                      | sell signal                                         | result              |
| ----------------------------------------------- | --------------------------------------------------- | ------------------- |
| insider buy + buyback + count-down + low pledge | —                                                   | strong accumulation |
| —                                               | insider sell + high pledge + count-up + unlock soon | distribution / risk |
| mixed signals                                   | mixed signals                                       | wait for clarity    |

### Policy-Driven Analysis Tree (A-share unique)

```
Step 1: Sector identification
  fin_index(thematic/ths_index) → list all THS concept indices
  fin_index(thematic/ths_daily, symbol=concept_code) → concept momentum

Step 2: Policy sensitivity classification
  ├─ Encouraged sectors (NEV/chip/AI/green energy)
  │   → higher PE tolerance, subsidy tailwind, watch policy continuation
  ├─ Restricted sectors (gaming/education/real estate)
  │   → valuation discount, regulatory overhang
  └─ Neutral sectors (consumer/healthcare)
      → standard valuation framework

Step 3: Concept hype cycle detection
  fin_index(thematic/ths_daily, limit=20) → recent momentum
  ├─ Day 1-3: news catalyst, low volume → early stage
  ├─ Day 4-7: volume surge, limit-ups → fermentation
  ├─ Day 8-12: divergence starts → climax
  └─ Day 13+: leaders fall, laggards catch up → decay
  Action: enter early stage or avoid climax+

Step 4: Seasonal pattern overlay
  ├─ Jan-Feb: spring rally (small-cap + growth outperform)
  ├─ Apr: annual report season (quality factor dominates)
  ├─ Jul-Aug: interim reports (growth verification)
  └─ Oct-Dec: style switch (value regression, dividend plays)
```

**Stock-to-concept mapping:**
`fin_index(thematic/ths_member, symbol=concept_code)` → verify target stock is in the concept basket.

### Capital Flow Cross-Validation Tree (A-share unique)

Three-signal resonance model:

```
Signal 1: fin_stock(moneyflow/individual, symbol=X)
  → main force net inflow/outflow (institutional flow on single stock)

Signal 2: fin_market(market/top_list, date=YYYY-MM-DD) + fin_market(market/top_inst)
  → dragon-tiger list: which institutional seats are buying/selling
  → only triggered when stock hits unusual move thresholds
  → ⚠️ 这些端点使用 `date` 参数（非 `trade_date`）

Signal 3: fin_market(flow/hsgt_top10, date=YYYY-MM-DD)
  → northbound (foreign) holdings change on target stock

Cross-validation matrix:
  ├─ All 3 bullish (main inflow + inst buy + northbound add)
  │   → strong signal, high conviction
  ├─ Main + northbound aligned, no dragon-tiger entry
  │   → medium signal (not volatile enough for top_list)
  ├─ Main inflow but northbound selling
  │   → domestic-only play, watch for style divergence
  ├─ Northbound adding but main outflow
  │   → long-term foreign accumulation vs short-term domestic sell
  │   → usually positive on 3-6 month horizon
  └─ All 3 bearish → avoid
```

**Supplementary flow checks:**

- `fin_market(margin/detail, symbol=X)` → leveraged positioning trend
- `fin_market(moneyflow/block_trade, symbol=X)` → block trade premium/discount signals

### Price-Volume Tree

```
Step 1: fin_stock(price/historical, symbol=X, limit=60)
Step 2: fin_ta(sma, symbol=X, period=20) + fin_ta(sma, period=60)
        fin_ta(rsi, symbol=X) + fin_ta(macd, symbol=X)
  ├─ RSI>70 + MACD histogram declining → overbought
  ├─ RSI<30 + MACD histogram rising → oversold bounce
  └─ SMA20 cross SMA60 → golden/death cross
Step 3: Cross-validate with capital flow
  fin_stock(moneyflow/individual, symbol=X)
  ├─ RSI oversold + main inflow → bottom signal
  ├─ RSI overbought + main outflow → top signal
  └─ price down + main inflow → possible shakeout (accumulation)

Step 4: Composite Signal Synthesis (买卖信号灯)
  综合 RSI + MACD + 资金流 + 筹码结构 → 输出单一信号灯

  输入:
    T = technical score (RSI + MACD + 均线)
    F = flow score (资金流 + 龙虎榜 + 北向)
    C = chip score (股东增减 + 质押 + 回购)

  技术面评分 T (-3 to +3):
    RSI<30 = +1 | RSI>70 = -1 | 30-70 = 0
    MACD 金叉 = +1 | 死叉 = -1 | 零轴上方 = +0.5
    价格>MA20>MA60 = +1 | 价格<MA20<MA60 = -1

  资金面评分 F (-3 to +3):
    主力净流入 >5000万 = +1 | 净流出 >5000万 = -1
    北向净买入 = +1 | 净卖出 = -1
    龙虎榜机构净买 = +1 | 净卖 = -1

  筹码面评分 C (-3 to +3):
    股东人数下降 = +1 | 上升 = -1
    质押率 <20% = +0.5 | >50% = -1
    回购/增持 = +1 | 减持 = -1

  综合信号 = T + F + C (范围 -9 to +9)
    ├─ >= +5  → 买入信号 (强) — 建议关注支撑位加仓
    ├─ +3~+4  → 买入信号 (弱) — 可小仓位试探
    ├─ -2~+2  → 持有/观望 — 等待信号明确
    ├─ -4~-3  → 卖出信号 (弱) — 减仓或收紧止损
    └─ <= -5  → 卖出信号 (强) — 建议止损离场

  输出格式:
    信号灯: 买入(强)/买入(弱)/持有/卖出(弱)/卖出(强)
    支撑位: MA60 / 近期低点 (取较高者)
    阻力位: 近期高点 / 布林上轨 (取较低者)
    建议止损: 支撑位下方 2-3% (主板) 或 3-5% (创业板/科创板)
    置信度: 三维共振 (T/F/C 同向) = 高 | 二维共振 = 中 | 信号矛盾 = 低
```

**A22 预计算技术因子:** `fin_stock(fundamental/stock_factor, symbol=X, limit=60)` → 含 MACD/KDJ/RSI/BOLL/CCI 预计算值，可替代 `fin_ta` 逐个计算。适用于快速技术面扫描。

## Quick Patterns (Supplementary)

**A13 打板/连板:** `fin_market(market/limit_list, trade_date=D)` → 涨停家数+连板分布; `fin_market(market/top_list)` → 龙虎榜验证资金来源。连板>3天 + 机构席位净买 = 龙头确认; 首板放量+游资对倒 = 短炒警惕。
补充: `fin_stock(market/stock_limit, symbol=X)` → 个股涨跌停价（需带 symbol）。

**A14 次新股:** `fin_stock(profile)` → listing_date 筛选上市<1年; `fin_stock(price/historical, limit=60)` → 开板后走势。次新 + 流通盘<5亿 + 行业景气 = 高弹性; 破发 + 业绩下滑 = 回避。

**A15 同业PK:** 并行调 `fin_stock(fundamental/ratios)` + `fin_stock(fundamental/metrics)` 对比 ROE/毛利率/PE_deducted。深度因子筛选 → see **fin-factor-screen** skill。

**A16 高股息:** `fin_stock(fundamental/dividends, limit=5)` → 分红连续性; `fin_stock(fundamental/ratios)` → 股息率。连续5年 + 股息率>4% + 派息率<70% = 可持续; 派息率>90% 或 OCF 不支撑 = 陷阱。

**A17 商誉减值:** `fin_stock(fundamental/balance, limit=4)` → goodwill/net_assets 比值。>30% = 高风险; 业绩承诺到期年 = 减值窗口 (Q4年报季重点)。

**A18 注册制板块差异:**

| 板块         | 涨跌幅 | 退市   | 打新               |
| ------------ | ------ | ------ | ------------------ |
| 主板 (60/00) | ±10%   | 传统   | 中签率低, 收益稳   |
| 创业板 (300) | ±20%   | 注册制 | 波动大, 首日无涨停 |
| 科创板 (688) | ±20%   | 最严   | 需50万+2年门槛     |
| 北交所 (8)   | ±30%   | 直接   | 流动性弱, 精选     |

先用 `fin_stock(profile)` 确认板块, 再适配涨跌幅和风险框架。

**A19 国企改革:** `fin_stock(profile)` → 实控人识别央企/地方国企; `fin_stock(ownership/top10_holders)` → 国有股比例。ROE<行业均值 + 混改预期 = 改革催化; `fin_index(thematic/ths_member)` 查国企改革概念成分。

**A20 量化资金:** `fin_stock(price/historical, limit=20)` → 成交量突增>3倍均量但价格窄幅(<2%) = 量化特征; `fin_market(market/top_list)` → 量化席位频繁出现。量化主导 = 波动放大, 趋势策略优于均值回归。

**A21 两融标的:** `fin_market(margin/detail, symbol=X)` → 有数据=两融标的, 无数据=非两融。融资余额增+股价涨=杠杆多头; 融券激增=做空压力。非两融不可融券, 策略需纯多头。

## Data Boundaries

| Data                 | Update                 | Notes                                                                    |
| -------------------- | ---------------------- | ------------------------------------------------------------------------ |
| A-share quotes       | EOD ~18:00 CST         | not real-time intraday                                                   |
| Financial statements | quarterly              | AR: Apr, interim: Aug, Q3: Oct                                           |
| Earnings forecast    | analyst consensus      | small-cap may lack coverage                                              |
| Shareholder count    | quarterly disclosure   | lags real-time                                                           |
| Insider trades       | T+1 after announcement |                                                                          |
| Pledge data          | weekly update          |                                                                          |
| Northbound holdings  | T+1                    | daily top 10 only                                                        |
| Dragon-tiger list    | T+1                    | only unusual-move days                                                   |
| Block trades         | EOD same day           |                                                                          |
| Analyst consensus    | yfinance only          | A-share codes NOT supported; use `fundamental/earnings_forecast` instead |

## References

- Pledge tiers, lock-up rules, CAS vs IFRS differences, registration reform impacts — see Chip Analysis Tree and Policy-Driven Analysis Tree above
- DCF/DDM/PE Band methodology — see Valuation Tree above; use `fundamental/ratios` (dt_eps 计算 PE_deducted) for inputs
- DuPont decomposition, industry benchmarks — derive from `fundamental/ratios` (ROE breakdown) + `fin_index(constituents)` for peer comparison
