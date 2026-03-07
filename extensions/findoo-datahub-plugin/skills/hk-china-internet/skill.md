---
name: fin-hk-china-internet
description: "China Internet sector — 5-stock basket (Tencent/Alibaba/Meituan/JD/Bilibili) performance, valuation bands, fundamental scorecard, relative strength, regime overlay. Use when: user asks about China tech stocks, KWEB, China Internet valuation, Tencent vs Alibaba, or whether to buy China tech dip. NOT for: individual HK stock deep-dive (use fin-hk-stock), A-share tech stocks (use fin-a-share), US-listed ADRs (use fin-us-equity), southbound flow analysis (use fin-hk-southbound-alpha)."
metadata:
  { "openclaw": { "emoji": "\U0001F310", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# China Internet Sector Analysis

Analyze the 5 core China Internet stocks listed in Hong Kong as a basket and individually. Cut through sentiment noise with fundamental scorecards, valuation bands, and relative strength ranking. China Internet is an emotional rollercoaster — this skill provides the data-driven handrails.

## When to Use

- "中概互联网现在什么情况" / "How is China Internet doing?"
- "腾讯阿里美团怎么选" / "Tencent vs Alibaba vs Meituan comparison"
- "中概互联网现在便宜吗" / "Is China Internet cheap now?"
- "中概科技 basket 今年表现" / "China tech basket YTD return"
- "中概互联网抄底" / "Should I buy the China tech dip?"
- "哪只中概互联网最强" / "Which China Internet stock is leading?"
- "腾讯估值处于历史什么位置" / "Where is Tencent's valuation historically?"

## When NOT to Use

- 单只港股深度分析 (00700.HK 财报全景) → use `/fin-hk-stock`
- A 股科技股 (688xxx 科创板) → use `/fin-a-share`
- 美股 ADR 分析 (BABA/JD US-listed) → use `/fin-us-equity`
- 南向资金趋势分析 → use `/fin-hk-southbound-alpha`
- 恒指整体估值 → use `/fin-hk-hsi-pulse`
- 港股高息股 → use `/fin-hk-dividend-harvest`
- 宏观数据 (GDP/CPI) → use `/fin-macro`

## Basket Universe

| Code     | Company  | Weight | Sector Focus             |
| -------- | -------- | ------ | ------------------------ |
| 00700.HK | Tencent  | 20%    | Gaming, social, fintech  |
| 09988.HK | Alibaba  | 20%    | E-commerce, cloud        |
| 03690.HK | Meituan  | 20%    | Local services, delivery |
| 09618.HK | JD.com   | 20%    | E-commerce, logistics    |
| 09626.HK | Bilibili | 20%    | Video, gaming, Gen-Z     |

Equal-weighted basket. When computing basket return: simple average of 5 individual returns.

## Tools & Parameters

### fin_stock — Individual stock data

| Parameter  | Type   | Required | Format     | Default | Example          |
| ---------- | ------ | -------- | ---------- | ------- | ---------------- |
| symbol     | string | Yes      | XXXXX.HK   | —       | 00700.HK         |
| endpoint   | string | Yes      | see below  | —       | price/historical |
| start_date | string | No       | YYYY-MM-DD | —       | 2025-01-01       |
| end_date   | string | No       | YYYY-MM-DD | —       | 2026-03-07       |
| limit      | number | No       | 1-5000     | 200     | 250              |

#### Endpoints

| endpoint             | Description           | Example                                                                |
| -------------------- | --------------------- | ---------------------------------------------------------------------- |
| `price/historical`   | OHLCV for each stock  | `fin_stock(symbol="00700.HK", endpoint="price/historical", limit=250)` |
| `hk/income`          | IFRS income statement | `fin_stock(symbol="00700.HK", endpoint="hk/income", limit=8)`          |
| `fundamental/ratios` | PE/PB/PS/ROE          | `fin_stock(symbol="00700.HK", endpoint="fundamental/ratios")`          |
| `profile`            | Company overview      | `fin_stock(symbol="00700.HK", endpoint="profile")`                     |

### fin_data_regime — Sector regime detection

| Parameter | Type   | Required | Example  |
| --------- | ------ | -------- | -------- |
| symbol    | string | Yes      | 00700.HK |
| market    | string | Yes      | equity   |

### fin_ta — Technical analysis

| Parameter | Type   | Required | Example  |
| --------- | ------ | -------- | -------- |
| symbol    | string | Yes      | 00700.HK |
| indicator | string | Yes      | rsi      |

### fin_market — Southbound flow context

| endpoint         | Description              | Example                                           |
| ---------------- | ------------------------ | ------------------------------------------------- |
| `flow/ggt_daily` | Southbound daily net buy | `fin_market(endpoint="flow/ggt_daily", limit=20)` |

## China Internet Analysis Pattern

1. **Basket performance snapshot** — Pull prices for all 5 stocks
   `fin_stock(symbol="00700.HK", endpoint="price/historical", limit=250)` — repeat for 09988/03690/09618/09626
   - Compute: individual YTD/1M/3M returns + equal-weight basket return
   - Compute: basket return vs HSI return = basket alpha
   - ⚠️ If basket alpha > 10% → sector strongly outperforming, momentum play
   - ⚠️ If basket alpha < -10% → sector under heavy pressure, check fundamentals (step 3)
   - 💡 Rank 5 stocks by return: leaders vs laggards reveal market's sector preferences

2. **Relative strength ranking** — Identify divergence within basket
   - Rank 5 stocks by 1M/3M/YTD return
   - Compute: return spread (best performer - worst performer)
   - ⚠️ If spread > 30% → severe divergence, not a "rising tide lifts all boats" market
   - ⚠️ If Bilibili (09626) significantly underperforming → growth/profitability concerns in smaller names
   - 💡 Leaders rotating from value (BABA/JD) to quality (Tencent/Meituan) or vice versa = market sentiment shift

3. **Fundamental scorecard** `fin_stock(endpoint="hk/income", limit=8)` for each stock — Revenue/margin quality
   - For each stock extract: revenue YoY growth, gross margin, operating margin, net income
   - Build scorecard:
     | Metric | Scoring |
     | ------------------ | -------------------------------- |
     | Revenue growth | >15% = strong, 5-15% = moderate, <5% = weak |
     | Gross margin trend | Expanding = positive, compressing = negative |
     | Operating margin | >15% = healthy, <10% = pressure |
     | Net income | Positive + growing = strong |
   - ⚠️ If revenue growth <5% AND margin compressing → "structural slowdown", not just cyclical
   - ⚠️ If net income negative (Bilibili historically) → check OCF — cash burn rate matters
   - 💡 Cross-ref: margin improvement = "降本增效" (cost-cutting) narrative — sustainable if revenue still growing, fragile if revenue flat

4. **Valuation band analysis** `fin_stock(endpoint="fundamental/ratios")` for each stock — Historical context
   - For each: current PE/PS + 3Y/5Y percentile position
   - ⚠️ If PE < 25th percentile of 5Y range → historically cheap for this stock
   - ⚠️ If PS < 1x for any name (e.g., Alibaba/JD) → "priced for permanent impairment"
   - 💡 Compare across basket: Tencent PE premium over Alibaba PE — if spread narrows, market seeing convergence
   - 💡 PE alone can mislead for growth stocks — also check PS (revenue-based) and PEG if growth data available

5. **Regime and technical overlay** `fin_data_regime(symbol="00700.HK", market="equity")` — Trend direction
   - Check regime for Tencent (sector bellwether) as proxy for sector regime
   - `fin_ta(symbol="00700.HK", indicator="rsi")` — Overbought/oversold check
   - ⚠️ If RSI <30 for 2+ basket members → sector oversold, potential bounce
   - ⚠️ If RSI >70 for 3+ basket members → sector overheated, take-profit risk
   - 💡 Combine: cheap valuation (step 4) + oversold RSI + bullish regime = strongest entry signal
   - 💡 Combine: expensive valuation + overbought RSI + bearish regime = strongest exit signal

6. **Southbound flow context** `fin_market(endpoint="flow/ggt_daily", limit=20)` — Mainland money behavior
   - On days with large southbound inflow, check if tech names had volume spikes
   - ⚠️ If southbound surging + tech volume spiking → mainland "smart money" rotating into sector
   - ⚠️ If southbound surging but tech volume flat → flow going to dividend/banks, not tech
   - 💡 Cross-ref `/fin-hk-southbound-alpha` for full flow analysis

7. **Policy risk assessment** — The X-factor for China Internet
   - Not data-driven (no endpoint), but MUST be included in every analysis
   - Key risk factors: antitrust enforcement, data security regulation, gaming restrictions, geopolitics
   - ⚠️ Always mention that regulatory risk is the #1 non-fundamental driver of China Internet valuations
   - 💡 Historical pattern: post-regulation-shock recovery takes 6-18 months, but stocks typically overshoot on downside

## Signal Quick-Reference

| Basket Condition                     | Valuation          | Regime/RSI     | Signal                |
| ------------------------------------ | ------------------ | -------------- | --------------------- |
| Basket alpha >10%, all 5 rising      | Fair/cheap         | Bullish        | Momentum buy          |
| Basket alpha <-10%, divergence high  | Deep value (<25th) | Oversold (<30) | Contrarian accumulate |
| Basket alpha <-10%, margins falling  | Fair               | Bearish        | Avoid / wait          |
| Leaders rotating value→quality       | Mixed              | Neutral        | Be selective          |
| Tencent/Meituan leading, BABA/JD lag | Premium expanding  | Mixed          | Quality over value    |

## Data Notes

- **Price data**: yfinance, ~15 min delay, historical data reliable for trend analysis
- **HK financials**: tushare `hk/income`, semi-annual (interim Aug, annual Feb-Apr), lag 1-2 months after filing
- **Fundamental ratios**: yfinance, PE/PB/PS updated with market price, earnings from last filing
- **Regime detection**: algorithmic, not a forecast; reflects current trend state
- **RSI**: 14-period default from fin_ta
- **Missing**: ETF data (2840.HK/KWEB AUM/flow), ADR premium (BABA ADR vs 09988.HK spread), regulatory event timeline database, analyst consensus estimates
- **ADR linkage**: for ADR-listed names (BABA/JD/BILI), use `/fin-us-equity` for US-side price; spread = US close converted to HKD vs HK close

## Response Guidelines

### Number Format

- Stock price: HK$388.60 (2 decimals with HK$ prefix)
- PE/PS: 20.5x / 1.8x (1 decimal + "x")
- Returns: +25.3% / -8.1% (always signed, 1 decimal)
- Revenue: 1,528 亿 RMB (integer, specify RMB for mainland-incorporated companies)
- Gross margin: 47.2% (1 decimal)
- Basket alpha: +12pp (percentage points vs HSI)

### Must Include

- Data cutoff date
- Basket equal-weight return vs HSI (alpha)
- Individual stock return ranking (leader to laggard)
- At least 2 stocks' valuation percentile position
- Fundamental scorecard summary (revenue growth + margin trend for each)
- Regime label for sector
- Policy/regulatory risk caveat (EVERY response must mention this)

### Display Format

- Lead with basket snapshot (1-2 sentences: basket return, alpha, divergence level)
- Performance table: 5 stocks x (Price / 1M / 3M / YTD / PE / PS)
- Fundamental scorecard table: 5 stocks x (Rev Growth / Gross Margin / Op Margin / Net Income trend)
- Valuation context: current PE vs 5Y range (cheap/fair/expensive label)
- Relative strength ranking: #1 to #5 with brief reason
- End with: sector signal + policy risk caveat + what to watch next
