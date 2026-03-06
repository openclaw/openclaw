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

Formula: `premium = (A_price / H_price * exchange_rate) - 1`

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
