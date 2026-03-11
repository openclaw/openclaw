---
name: fin-hk-stock
description: "HK stock analysis — IFRS financials (hk/income, hk/balancesheet, hk/cashflow), AH premium arbitrage calculation (hk/adj_factor), southbound capital tracking (ggt_daily/ggt_monthly), liquidity trap detection, dividend tax tiers (H-share 20%/red-chip 10%), HKD peg rate transmission via HIBOR. Use when: user mentions HK codes (00700.HK/09988.HK), asks about AH premium, southbound flow, or HK-specific valuation traps. NOT for: A-shares (use fin-a-share), US stocks (use fin-us-equity), crypto (use fin-crypto), northbound capital into A-shares (use fin-a-share-radar)."
metadata:
  {
    "openclaw":
      { "emoji": "\U0001F1ED\U0001F1F0", "requires": { "extensions": ["findoo-datahub-plugin"] } },
  }
---

# HK Stock Analysis

Use **fin_stock**, **fin_market**, **fin_macro**, **fin_ta** for Hong Kong equity research. Primary providers: tushare (HK financials, southbound flow), yfinance (quotes, ratios).

## Symbol Format

| Market                  | Format            | Examples                     |
| ----------------------- | ----------------- | ---------------------------- |
| HK Main Board           | 5-digit + .HK     | 00700.HK, 01398.HK, 09988.HK |
| HK GEM                  | 5-digit + .HK     | 08083.HK                     |
| AH dual-listed (A-side) | 6-digit + .SH/.SZ | 601398.SH, 601318.SH         |

## Available Endpoints

### fin_stock (HK subset)

`price/historical` (OHLCV), `hk/income` (IFRS P&L), `hk/balancesheet` (资产负债表), `hk/cashflow` (现金流量表), `hk/fina_indicator` (财务指标), `hk/basic` (基本信息), `hk/adj_factor` (复权因子), `hk/trade_cal` (交易日历), `fundamental/ratios` (PE/PB/PS), `profile` (overview), `discovery/gainers` (movers). Providers: yfinance + tushare.

| endpoint            | data              | use case                          |
| ------------------- | ----------------- | --------------------------------- |
| `hk/income`         | 港股利润表 (IFRS) | 营收/利润/毛利率分析              |
| `hk/balancesheet`   | 港股资产负债表    | 资产质量、杠杆分析                |
| `hk/cashflow`       | 港股现金流量表    | OCF/NI 质量验证                   |
| `hk/fina_indicator` | 港股财务指标      | ROE/ROA 等衍生指标                |
| `hk/basic`          | 港股基本信息      | 上市状态、行业分类                |
| `hk/adj_factor`     | 复权因子          | AH 溢价精确计算、长期净值对比     |
| `hk/trade_cal`      | 港股交易日历      | 南向资金分析需区分交易日/非交易日 |

### fin_market (southbound capital)

`flow/ggt_daily` (daily net buy), `flow/ggt_monthly` (月度汇总), `flow/hs_const` (Connect constituents). Provider: tushare.

⚠️ `flow/ggt_top10` 已知超时不可用，暂勿调用。`flow/ggt_daily` 正常（最新 2026-03-05）。

补充: `fin_market(endpoint="flow/ggt_monthly")` → 南向月度汇总，适合中长期趋势判断。

### Auxiliary tools

- **fin_macro**: `hibor` (HKD rate, tracks Fed), `currency/price/historical` USDCNH (AH calc)
- **fin_index**: `daily_basic` (HSI valuation)
- **fin_ta**: `sma`, `rsi`, `macd`, `bbands` on any HK symbol
- **fin_data_ohlcv** / **fin_data_regime**: cached candles + regime detection

## Analysis Patterns

### AH Premium Arbitrage (HK core pattern)

```
Step 1: fin_stock(symbol="601398.SH", endpoint="price/historical") -> A-share price
Step 2: fin_stock(symbol="01398.HK", endpoint="price/historical") -> H-share price
Step 3: fin_macro(endpoint="currency/price/historical", symbol="USDCNH") -> exchange rate
```

Formula: `premium = A_price_CNY / (H_price_HKD × CNYHKD_rate) - 1`

> ⚠️ H 股以 HKD 计价（非 USD），需用 CNY/HKD 汇率。
> 获取方式: `fin_macro(currency/price/historical, symbol="USDCNH")` 和 `fin_macro(currency/price/historical, symbol="USDHKD")`，
> 然后 CNYHKD = USDHKD / USDCNH。旧公式 `A/H*USDCNH` 币种错误。

| Percentile | Signal                      |
| ---------- | --------------------------- |
| > 75th     | Long H-share (A overvalued) |
| < 25th     | Long A-share (H overvalued) |
| 25-75th    | Neutral                     |

Common AH pairs (top 10): ICBC (601398/01398), Ping An (601318/02318), Conch Cement (600585/00914), PetroChina (601857/00857), Sinopec (600028/00386), China Life (601628/02628), CNOOC (600938/00883), BYD (002594/01211), China Shenhua (601088/01088), Bank of China (601988/03988).

Seasonal premium: Q4 "跨年行情" drives A-share sentiment → premium expansion; contracts during HK earnings season (Mar/Aug) as H-share fundamentals re-anchor. Cross-ref: `fin-a-share` for A-side analysis.

### Southbound Capital Tracking (HK-exclusive)

```
Step 1: fin_market(endpoint="flow/ggt_daily", limit=20) -> 20-day net buy
Step 2: fin_market(endpoint="flow/ggt_monthly") -> 月度趋势判断
Step 3: fin_market(endpoint="flow/hs_const") -> verify Connect eligibility
# NOTE: flow/ggt_top10 已超时不可用，用 ggt_daily 大额净买入替代
```

| Pattern                            | Signal               |
| ---------------------------------- | -------------------- |
| 5-day consecutive net buy > 5B HKD | Trend allocation     |
| Single-day net buy > 10B HKD       | Major bottom-fishing |
| Consecutive net sell               | Short-term pressure  |
| ggt_monthly 连续 3 月净流入        | 中长期趋势性配置     |
| 单日净买入突然放大 >3x 均值        | 集中性机构配置信号   |

### Liquidity Trap Detection (HK-exclusive)

```
fin_stock(symbol="XXXXX.HK", endpoint="price/historical", limit=20)
-> compute avg daily turnover from volume * close
```

| Daily Turnover (HKD) | Assessment                                 |
| -------------------- | ------------------------------------------ |
| < 10M                | Liquidity trap — easy to buy, hard to exit |
| 10M - 100M           | Moderate liquidity                         |
| > 100M               | Good liquidity                             |

Board lot impact (HK 特色): HK uses variable board lots (e.g. Tencent 100 shares/lot at ~HKD 380 = HKD 38K minimum). Check `profile` for lot size; real minimum investment = board_lot × price. High-price stocks with large lots create de facto retail barriers.

### HK Valuation Specifics

Dividend tax tiers (critically affects real yield):

- **H-shares** (mainland-incorporated): 20% withholding
- **Red-chips** (HK-incorporated, mainland ops): 10% withholding
- **Foreign investors**: 0%
- **Through Stock Connect (southbound)**: 20% for individuals, 10% for institutions

Valuation trap decision tree — low PE alone is insufficient:

1. **Liquidity check**: daily turnover < 10M HKD? → EXIT (illiquid discount justified)
2. **Cycle check**: `hk/income` → revenue declining YoY? → likely cyclical peak, PE misleading
3. **Governance check**: `profile` → free float < 25%? → governance/manipulation risk
4. **Policy check**: sector in recent regulatory crosshair? → political risk premium justified
5. Only if all 4 pass → proceed with fundamental valuation using `fundamental/ratios`

### HKD Peg Rate Transmission

```
fin_macro(endpoint="hibor") -> HIBOR tracks US rates via peg
```

| Fed Action                    | HIBOR Impact                       | HK Equity Impact      |
| ----------------------------- | ---------------------------------- | --------------------- |
| Rate hike                     | HIBOR rises                        | Valuation compression |
| Rate cut                      | HIBOR falls                        | Valuation expansion   |
| Peg pressure (7.85 weak-side) | HKMA intervention, liquidity drain | Negative              |

### Technical Analysis

```
fin_data_ohlcv(symbol="00700.HK", market="equity", timeframe="1d")
fin_ta(symbol="00700.HK", indicator="rsi")  // + macd, bbands
fin_data_regime(symbol="00700.HK", market="equity")
```

## HK-Specific Patterns

### 中概互联网板块分析 (China Internet Sector)

Basket: Tencent (00700.HK), Alibaba (09988.HK), Meituan (03690.HK), JD (09618.HK), Bilibili (09626.HK).

```
Step 1: fin_stock(symbol="00700.HK", endpoint="price/historical", limit=60) -> repeat for all 5
Step 2: fin_stock(symbol="00700.HK", endpoint="hk/income") -> compare revenue/margin across basket
Step 3: fin_data_regime(symbol="00700.HK", market="equity") -> sector regime
Step 4: fin_market(endpoint="flow/ggt_daily", limit=20) -> mainland net buy trend for this sector
```

Equal-weighted basket return divergence from HSI > 5% = sector alpha signal. Compare `hk/income` gross margins to identify relative strength. Cross-ref: `fin-etf-fund` for ETF tracking; `fin-macro` USDCNH for ADR/HK spread.

### 港股高股息策略 (HK Dividend Play)

```
Step 1: fin_stock(symbol="XXXXX.HK", endpoint="fundamental/ratios") -> PE, PB, dividend yield
Step 2: fin_stock(symbol="XXXXX.HK", endpoint="hk/income") -> earnings stability check
Step 3: fin_stock(symbol="XXXXX.HK", endpoint="price/historical", limit=60) -> volume for liquidity
```

| Factor                   | Threshold            | Why                         |
| ------------------------ | -------------------- | --------------------------- |
| Dividend yield (pre-tax) | > 5%                 | Compensates H4 20% tax drag |
| PE                       | < 12x                | Margin of safety            |
| Daily turnover           | > 50M HKD            | Avoid liquidity trap        |
| Earnings trend           | Stable or growing 3Y | Sustainable payout          |

After-tax yield = headline yield × (1 - tax_rate). H-share 6% headline = 4.8% net; red-chip 6% = 5.4% net. Always compare net yields.

### 恒生指数估值分析 (HSI Valuation)

```
Step 1: fin_index(symbol="HSI", endpoint="daily_basic", limit=250) -> PE/PB history
Step 2: fin_index(symbol="HSI", endpoint="price/historical", limit=250) -> price context
Step 3: fin_macro(endpoint="hibor") -> rate environment
```

HSI PE bands (10Y): <10th (~8x) = deep value; 10-25th (~9-10x) = accumulate; 25-75th (~10-12x) = fair; >75th (~13x+) = reduce.

### 港股午盘效应 (Lunch Break Reversal)

HK lunch break 12:00-13:00 HKT. Morning sell-off often reverses in PM session (fresh southbound flow). Use `fin_data_ohlcv(timeframe="1h")` — the 13:00-14:00 bar frequently shows reversal characteristics.

### IPO 打新框架 (HK IPO Framework)

```
fin_stock(symbol="XXXXX.HK", endpoint="profile") -> listing date
fin_stock(symbol="XXXXX.HK", endpoint="price/historical", limit=30) -> first 30 days
fin_market(endpoint="flow/ggt_daily", limit=5) -> southbound interest near listing date
```

Cornerstone lock-up (typically 6 months) → selling pressure near expiry. First-day gain >10% with declining volume = early exit signal.

## Stock Connect (港股通) Trading Guide

港股通交易规则速查，帮助内地投资者避免常见操作失误。

### 费用结构

| 费用项目 | 费率                       | 备注                      |
| -------- | -------------------------- | ------------------------- |
| 佣金     | ~0.03-0.25%                | 各券商不同，最低 ~50 HKD  |
| 印花税   | 0.13%                      | 双向收取 (2024年下调后)   |
| 交易征费 | 0.00565%                   | 证监会征费                |
| 交易费   | 0.00231%                   | 联交所                    |
| 结算费   | 0.002%                     | 最低 2 HKD，最高 100 HKD  |
| 股息税   | 20% (H股个人) / 10% (红筹) | 见 HK Valuation Specifics |

**综合费率:** 单边约 0.17-0.40%，远高于 A 股 (~0.05%)。频繁交易成本显著。

### 交易时间 (HKT)

| 时段         | 时间        | 说明         |
| ------------ | ----------- | ------------ |
| 开市前竞价   | 09:00-09:30 | 港股通不参与 |
| 上午持续交易 | 09:30-12:00 | 可交易       |
| 午间休市     | 12:00-13:00 | 不可交易     |
| 下午持续交易 | 13:00-16:00 | 可交易       |
| 收市竞价     | 16:00-16:10 | 部分券商支持 |

⚠️ 港股通在非共同交易日不可交易（如 A 股休市但港股开市的日子）。用 `fin_stock(endpoint="hk/trade_cal")` 查询港股交易日历。

### 结算规则

| 规则           | 说明                                                |
| -------------- | --------------------------------------------------- |
| 交收周期       | **T+2** (区别于 A 股 T+1)                           |
| 卖出可用       | T 日卖出资金 T+2 到账，但可 T 日用于买入港股        |
| 不支持当日回转 | 买入当天**不可卖出** (非 T+0)                       |
| 碎股处理       | 送股/拆股产生碎股只能通过碎股交易卖出，无法买入补齐 |

### 可交易标的

```
fin_market(endpoint="flow/hs_const") → 查询当前港股通可交易标的名单
```

| 条件              | 说明                                              |
| ----------------- | ------------------------------------------------- |
| 恒生综合大型/中型 | 自动纳入                                          |
| A+H 股            | 自动纳入 H 股端                                   |
| 恒生综合小型      | 需满足市值/流动性门槛                             |
| 排除类别          | 外国公司 (二次上市除外)、合订证券、仅供专业投资者 |

⚠️ 名单每半年调整一次（3月/9月），调整前后是潜在交易机会窗口。

### 额度与限制

| 限制         | 额度                                             |
| ------------ | ------------------------------------------------ |
| 每日额度     | 520 亿 RMB (沪港通+深港通各自独立)               |
| 总额度       | 已取消                                           |
| 最小交易单位 | 1 手 (每手股数因股票而异，见 `profile` lot_size) |

### 常见陷阱

1. **汇率损耗**: 买入用 RMB 换 HKD (买入汇率)，卖出用 HKD 换 RMB (卖出汇率)，中间存在点差 (~0.1-0.3%)
2. **碎股锁仓**: 送股后产生碎股，只能在碎股市场折价卖出
3. **暗盘不可参与**: 港股通无法参与 IPO 暗盘交易
4. **节假日错配**: 圣诞/复活节等港股休市但 A 股开市，或反之 → 资金闲置
5. **红利税差异**: 不同持股类型税率差异大，影响实际收益 (见上方费用结构)

## DataHub Gaps (HK)

| Missing Data                      | Ideal Source | Workaround                                                                  |
| --------------------------------- | ------------ | --------------------------------------------------------------------------- |
| CCASS custody details             | HKEX         | `ggt_daily` 大额净买入作为大陆持仓变动代理                                  |
| AH premium index (HSAHP)          | Wind         | Manual calc: pull both A/H prices + USDCNH rate                             |
| Short selling data                | HKEX         | High volume + price drop as directional proxy                               |
| Hang Seng industry classification | HSIL         | Use `profile` sector field as rough substitute                              |
| Board lot size                    | HKEX         | Check `profile` or assume standard lots; verify minimum investment manually |
| CCASS participant changes         | HKEX         | Track `ggt_daily` 连续大额净买入作为机构流向代理                            |

## Data Boundaries

| Data                 | Frequency      | Latency             | Notes                                                     |
| -------------------- | -------------- | ------------------- | --------------------------------------------------------- |
| HK quotes            | Intraday       | ~15min delay        | yfinance                                                  |
| HK IFRS financials   | Semi-annual    | Post-filing         | tushare `hk/income`, `hk/balancesheet`, `hk/cashflow`     |
| HK 复权因子          | Daily          | T+1                 | tushare `hk/adj_factor` (5353 records, latest 2026-03-05) |
| HK 交易日历          | —              | 预生成至 2026-12-31 | tushare `hk/trade_cal`                                    |
| Southbound flow      | EOD / Monthly  | Post-close          | tushare `ggt_daily` + `ggt_monthly`                       |
| HIBOR                | Daily          | Trading days        | tushare                                                   |
| Connect constituents | Monthly update | —                   | tushare                                                   |
