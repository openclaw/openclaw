---
name: fin-us-sector-rotation
description: "US sector rotation — GICS 11-sector ETF scoreboard (XLK/XLF/XLE/XLV/XLU/XLI/XLB/XLP/XLY/XLRE/XLC), economic cycle positioning, sector vs SPY relative strength, valuation by sector. Use when: user asks about sector rotation, which industry to buy, economic cycle stage, or sector ETF comparison. NOT for: individual US stocks (use fin-us-equity), US ETF portfolio/DCA (use fin-us-etf), A-share sectors (use fin-a-share), macro rates only (use fin-macro), crypto sectors (use fin-crypto-altseason)."
metadata: { "openclaw": { "emoji": "🏭", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# US Sector Rotation

Economic cycle positioning + GICS sector momentum = systematic allocation framework. This skill turns "which sector should I buy" from gut feeling into data-driven rotation decisions.

> **Scope boundary:** This skill covers US sector-level analysis and rotation strategy. For individual US stock analysis, use `/fin-us-equity`. For ETF portfolio construction and DCA, use `/fin-us-etf`. For macro rates and yield curve, use `/fin-macro`.

## When to Use

- "现在该买哪个行业" / "Which sector should I buy now?"
- "科技股 vs 能源股" / "Tech vs Energy comparison"
- "经济周期在什么阶段" / "What stage of the economic cycle are we in?"
- "行业轮动到哪里了" / "Where is sector rotation heading?"
- "防御性板块是不是该配了" / "Should I add defensive sectors?"
- "XLK 和 XLV 哪个好" / "XLK vs XLV comparison"
- "哪个行业估值最低" / "Which sector has the lowest valuation?"

## When NOT to Use

- 美股个股深度分析 (AAPL, NVDA) → use `/fin-us-equity`
- ETF 组合配置 / 定投模拟 / ETF 对比 → use `/fin-us-etf`
- 宏观利率 / 国债收益率 / GDP/CPI → use `/fin-macro`
- A 股行业 / 板块分析 → use `/fin-a-share`
- 加密货币赛道轮动 → use `/fin-crypto-altseason`
- 美股期权策略 → use `/fin-us-equity` (options section)

## Tools & Parameters

### fin_stock (Sector ETF price + fundamentals)

| Parameter | Type   | Required | Format    | Default | Example          |
| --------- | ------ | -------- | --------- | ------- | ---------------- |
| symbol    | string | Yes      | US ticker | —       | XLK              |
| endpoint  | string | Yes      | see below | —       | price/historical |
| provider  | string | No       | yfinance  | auto    | yfinance         |
| limit     | number | No       | 1-5000    | 250     | 250              |

> **Important:** For US ETFs, always use `provider="yfinance"` with `price/historical`. Default tushare provider returns 500 for US symbols.

#### Endpoints

| endpoint                        | Description             | Example                                                                     |
| ------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `price/historical`              | Sector ETF OHLCV        | `fin_stock(symbol="XLK", endpoint="price/historical", provider="yfinance")` |
| `fundamental/ratios`            | Sector ETF basic ratios | `fin_stock(symbol="XLK", endpoint="fundamental/ratios")`                    |
| `fundamental/earnings_forecast` | Earnings consensus      | `fin_stock(symbol="XLK", endpoint="fundamental/earnings_forecast")`         |
| `profile`                       | ETF description         | `fin_stock(symbol="XLK", endpoint="profile")`                               |

### Auxiliary Tools

| tool              | endpoint       | use case                                     |
| ----------------- | -------------- | -------------------------------------------- |
| `fin_macro`       | `treasury_us`  | Yield curve for economic cycle determination |
| `fin_ta`          | `rsi/sma/macd` | Sector ETF technical momentum                |
| `fin_data_regime` | —              | SPY regime for macro overlay                 |
| `fin_data_ohlcv`  | —              | Sector ETF K-line data                       |
| `fin_index`       | `daily_basic`  | Index valuation (for cross-reference)        |

## Sector ETF Reference

### SPDR Select Sector ETFs (11 GICS Sectors)

| Ticker | Sector             | Expense | Cycle Phase          | Rate Sensitivity |
| ------ | ------------------ | ------- | -------------------- | ---------------- |
| XLK    | Technology         | 0.09%   | Early/Late Expansion | High (negative)  |
| XLF    | Financials         | 0.09%   | Early Recovery       | High (positive)  |
| XLE    | Energy             | 0.09%   | Late Cycle/Inflation | Low              |
| XLV    | Healthcare         | 0.09%   | Defensive/Late Cycle | Low              |
| XLU    | Utilities          | 0.09%   | Recession/Defensive  | High (negative)  |
| XLI    | Industrials        | 0.09%   | Early Recovery       | Moderate         |
| XLB    | Materials          | 0.09%   | Mid Cycle/Inflation  | Moderate         |
| XLP    | Consumer Staples   | 0.09%   | Recession/Defensive  | Low              |
| XLY    | Consumer Discret.  | 0.09%   | Early Recovery       | Moderate         |
| XLRE   | Real Estate        | 0.09%   | Rate Sensitive       | Very High (neg)  |
| XLC    | Communication Svcs | 0.09%   | Growth-oriented      | High (negative)  |

### SPY as Benchmark

| Ticker | Description | Use                                         |
| ------ | ----------- | ------------------------------------------- |
| SPY    | S&P 500     | Benchmark for relative strength calculation |

## Sector Rotation Analysis Pattern

### 1. Sector Scoreboard

1. **Pull price history for all 11 sectors + SPY** — `fin_stock(symbol="XLK", endpoint="price/historical", provider="yfinance", limit=250)` for each sector ETF + SPY
   - Calculate for each: 1W return, 1M return, 3M return, YTD return
   - Calculate relative return vs SPY for each period (sector return - SPY return)
   - Rank by 3M relative return (primary momentum signal)
   - ⚠️ If top sector 3M relative return > +10% AND RSI > 70 → overbought, potential mean reversion
   - ⚠️ If bottom sector 3M relative return < -10% AND RSI < 30 → oversold, potential contrarian opportunity
   - 💡 Sector leading for > 6 months with decelerating momentum = exhaustion risk

2. **Momentum quality check** — `fin_ta(indicator="rsi", symbol="XLK", market="equity")` for top/bottom sectors
   - RSI > 70 on sector ETF = overbought → trim bias
   - RSI < 30 on sector ETF = oversold → accumulate bias
   - 💡 Divergence between price (new high) and RSI (lower high) = weakening momentum

### 2. Economic Cycle Positioning

1. **Yield curve assessment** — `fin_macro(endpoint="treasury_us")` → 2Y and 10Y yields
   - Calculate 2Y-10Y spread
   - ⚠️ If spread < 0 (inverted) → late cycle / recession warning → rotate to defensives (XLU, XLP, XLV)
   - ⚠️ If spread steepening from inversion → early recovery signal → rotate to cyclicals (XLF, XLY, XLI)
   - 💡 Cross-validate with `fin_data_regime(symbol="SPY", market="equity")` for regime confirmation

2. **Cycle phase determination** — Combine yield curve + SPY regime + sector leadership

| Cycle Phase      | Yield Curve Signal         | Sector Leaders      | Sector Laggards |
| ---------------- | -------------------------- | ------------------- | --------------- |
| Early Recovery   | Steepening from inversion  | XLF, XLY, XLI, XLB  | XLU, XLP        |
| Mid Expansion    | Normal slope, rates rising | XLK, XLC, XLI       | XLU, XLRE       |
| Late Expansion   | Flattening, rates elevated | XLE, XLB, XLK       | XLY, XLRE       |
| Recession/Crisis | Inverting or steep-falling | XLU, XLP, XLV, cash | XLY, XLF, XLI   |

- ⚠️ Cycle phases are not precise — use as directional bias, not timing tool
- 💡 If SPY regime = "bear" or "crisis" but yield curve suggests early recovery → possible inflection, watch for confirmation

### 3. Sector Valuation Assessment

1. **Relative valuation** — `fin_stock(symbol="XLK", endpoint="fundamental/ratios")` for each sector
   - Compare P/E across sectors
   - ⚠️ If sector P/E > 1.5x its 5-year median → expensive relative to history
   - ⚠️ If sector P/E < 0.7x its 5-year median → cheap relative to history
   - 💡 Low valuation + improving momentum = strongest rotation signal
   - 💡 High valuation + weakening momentum = strongest sell signal

### Historical Sector P/E Reference (approximate 5Y medians)

| Sector | Ticker | Approx 5Y Median P/E | Notes                       |
| ------ | ------ | -------------------- | --------------------------- |
| Tech   | XLK    | 28-32x               | Driven by AAPL/MSFT/NVDA    |
| Financ | XLF    | 12-15x               | Rate cycle dependent        |
| Energy | XLE    | 12-18x               | Commodity price dependent   |
| Health | XLV    | 16-20x               | Defensive premium           |
| Util   | XLU    | 17-21x               | Bond proxy, rate sensitive  |
| Indust | XLI    | 18-22x               | GDP growth correlated       |
| Mater  | XLB    | 15-19x               | Commodity/inflation linked  |
| Staple | XLP    | 20-24x               | Defensive premium           |
| Discr  | XLY    | 22-28x               | AMZN/TSLA weight distortion |
| RE     | XLRE   | 35-45x               | REIT accounting (use P/FFO) |
| Comms  | XLC    | 18-24x               | META/GOOG weight dominates  |

### 4. Rotation Decision Framework

```
Combine signals into rotation recommendation:

1. Momentum signal (Scoreboard 3M relative return ranking)
2. Cycle signal (Economic cycle phase → favored sectors)
3. Valuation signal (Current P/E vs historical median)

Strong BUY: Momentum top 3 + Cycle favored + Valuation below median
Strong SELL: Momentum bottom 3 + Cycle unfavored + Valuation above median
Hold/Neutral: Mixed signals across the three dimensions
```

- ⚠️ Never recommend >20% portfolio in a single sector (concentration risk)
- ⚠️ Rotation is gradual tilt adjustment (5-10% weight shift), not binary all-in/all-out
- 💡 If all three signals align → highest conviction rotation call

## Signal Quick-Reference

### Sector Rotation Playbook by Macro Regime

| Macro Signal                   | Recommended Sectors | Avoid Sectors    |
| ------------------------------ | ------------------- | ---------------- |
| Rate cuts beginning            | XLK, XLRE, XLU, XLY | XLE, XLF (mixed) |
| Rate hikes beginning           | XLF, XLE            | XLRE, XLU, XLK   |
| Inflation rising (CPI > 4%)    | XLE, XLB, XLI       | XLU, XLP, XLRE   |
| Recession fears (VIX > 25)     | XLU, XLP, XLV       | XLY, XLI, XLF    |
| AI/tech narrative dominant     | XLK, XLC            | XLE, XLB         |
| Dollar weakening (DXY falling) | XLE, XLB, Emerging  | XLK (mixed)      |

### Sector Correlation Clusters

Understanding which sectors move together helps diversification:

- **Cyclical cluster**: XLF + XLI + XLY + XLB (GDP-sensitive)
- **Defensive cluster**: XLU + XLP + XLV (recession-resistant)
- **Growth cluster**: XLK + XLC (duration-sensitive, rate-impacted)
- **Real assets cluster**: XLE + XLB + XLRE (inflation-linked)

## Data Notes

- **yfinance ETF data**: ~15min delay, covers price and basic fundamentals. Always specify `provider="yfinance"` for US ETFs.
- **Sector ETF P/E**: `fundamental/ratios` may return limited data for ETFs. The historical P/E medians in the reference table are approximate and should be cited as "approximate historical reference."
- **Economic cycle determination**: Based on yield curve shape + SPY regime. This is a simplified framework — professional cycle dating (NBER) lags by months.
- **Missing from DataHub**: Sector-level aggregate earnings growth, ETF fund flows, precise P/E percentiles. Use the hardcoded reference table for historical context.
- **Rotation lag**: Sector rotation signals are medium-term (1-3 months). Do not use for day-trading or short-term tactical moves.

## Response Guidelines

### Number Formats

- Sector ETF price: $185.40 (2 decimal places)
- Returns: +8.5% / -2.3% (always with +/- sign, 1 decimal)
- Relative return vs SPY: +3.2% / -1.8% (clearly labeled "vs SPY")
- P/E ratio: 28.5x (1 decimal, with "x" suffix)
- Yield curve spread: +45bp / -12bp (basis points)
- Expense ratio: 0.09% (2 decimal places)

### Must Include

- Data timestamp ("Data as of YYYY-MM-DD")
- Scoreboard table with all 11 sectors ranked
- Current economic cycle phase assessment with reasoning
- At least one ⚠️ risk signal (overbought/overvalued sector, or cycle transition warning)
- Relative returns vs SPY (not just absolute returns)

### Display Format

- Sector overview → 11-sector scoreboard table (ticker, sector, 1W, 1M, 3M, YTD, vs SPY, RSI)
- Cycle positioning → phase label + yield curve data + favored/avoid sectors
- Sector comparison → side-by-side table (return, P/E, cycle alignment, momentum)
- Single sector analysis → structured: Performance, Valuation, Cycle Fit, Momentum, Verdict
- Always include actionable rotation recommendation with conviction level (high/medium/low)
