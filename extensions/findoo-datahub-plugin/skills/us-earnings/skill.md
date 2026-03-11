---
name: fin-us-earnings
description: "US earnings season analysis — earnings calendar, historical beat/miss patterns, pre-earnings IV/straddle pricing, post-earnings price reaction stats, earnings surprise quantification. Use when: user asks about earnings dates, beat/miss history, earnings straddle, IV crush, or earnings season overview. NOT for: single-stock fundamentals/valuation (use fin-us-equity), A-share earnings (use fin-a-share), options Greeks lookup (use fin-derivatives), macro rates (use fin-macro)."
metadata: { "openclaw": { "emoji": "📅", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# US Earnings Season Analysis

Specialized in earnings **event-driven** analysis: calendar timing, beat/miss pattern recognition, pre-earnings options pricing, and post-earnings price reaction. Complements fin-us-equity's static fundamentals with temporal/event intelligence.

## When to Use

- "AAPL 财报什么时候出" / "When does AAPL report earnings"
- "NVDA 上季度 beat 了吗" / "Did NVDA beat last quarter"
- "财报前期权怎么玩" / "Pre-earnings straddle strategy"
- "这个财报季整体情况如何" / "How is this earnings season going"
- "TSLA 历史上财报后涨还是跌" / "TSLA post-earnings price reaction history"
- "哪些大公司下周报财报" / "Which mega-caps report next week"
- "GOOGL earnings surprise 有多大" / "GOOGL earnings surprise magnitude"

## When NOT to Use

- 个股基本面/估值/财务报表深度分析 (PE/PB/DCF) -> use `/fin-us-equity`
- A 股/港股财报分析 -> use `/fin-a-share` / `/fin-hk-stock`
- 纯期权 Greeks 查询 (非 earnings 相关) -> use `/fin-derivatives`
- 宏观利率/GDP/CPI -> use `/fin-macro`
- 股息/分红相关 -> use `/fin-us-dividend`
- 全市场雷达/涨跌幅排行 -> use `/fin-a-share-radar`

## Tools & Parameters

### fin_stock

| Parameter  | Type   | Required | Format          | Default | Example    |
| ---------- | ------ | -------- | --------------- | ------- | ---------- |
| symbol     | string | Yes      | US ticker       | —       | AAPL       |
| endpoint   | string | Yes      | see table below | —       | us/income  |
| start_date | string | No       | YYYY-MM-DD      | —       | 2025-01-01 |
| end_date   | string | No       | YYYY-MM-DD      | —       | 2026-03-07 |
| limit      | number | No       | 1-5000          | 200     | 20         |
| provider   | string | No       | yfinance        | auto    | yfinance   |

#### Endpoints

| endpoint                        | Description                    | Example                                                                      |
| ------------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `fundamental/earnings_forecast` | Analyst consensus EPS/Revenue  | `fin_stock(symbol="AAPL", endpoint="fundamental/earnings_forecast")`         |
| `us/income`                     | Actual GAAP EPS/Revenue        | `fin_stock(symbol="AAPL", endpoint="us/income")`                             |
| `price/historical`              | OHLCV for post-earnings moves  | `fin_stock(symbol="AAPL", endpoint="price/historical", provider="yfinance")` |
| `fundamental/ratios`            | Forward PE for re-rate context | `fin_stock(symbol="AAPL", endpoint="fundamental/ratios")`                    |
| `us/trade_cal`                  | US trading calendar            | `fin_stock(endpoint="us/trade_cal")`                                         |

### fin_derivatives

| endpoint         | Description                | Example                                                     |
| ---------------- | -------------------------- | ----------------------------------------------------------- |
| `options/chains` | Option chain + IV + Greeks | `fin_derivatives(endpoint="options/chains", symbol="AAPL")` |

### Auxiliary

| tool           | endpoint        | use case                        |
| -------------- | --------------- | ------------------------------- |
| `fin_currency` | `news/company`  | Earnings-related news catalyst  |
| `fin_ta`       | `rsi`, `bbands` | Post-earnings technical context |

## Earnings Season Calendar

**Quarterly cadence:** Jan (Q4 results), Apr (Q1), Jul (Q2), Oct (Q3).

**Reporting order:** Banks (week 2) -> Mega-cap tech (weeks 3-4) -> Mid/small-cap (weeks 4-6).

**Detection method:** When no dedicated earnings calendar API is available, use `fundamental/earnings_forecast` revision activity as a proxy — a spike in consensus revisions within 2-3 weeks signals an approaching report date.

## Earnings Analysis Pattern

1. **Consensus snapshot** `fin_stock(endpoint="fundamental/earnings_forecast", symbol="AAPL")` — Get analyst consensus EPS and Revenue estimates
   - Record: consensus EPS, number of analysts, high/low range
   - ⚠️ If analyst count < 5 -> small-cap coverage thin, consensus less reliable
   - 💡 Wide high-low range (spread > 30% of consensus) -> high uncertainty, larger potential surprise

2. **Historical beat/miss pattern** `fin_stock(endpoint="us/income", symbol="AAPL", limit=12)` — Pull last 8-12 quarters of actual EPS
   - Compare each quarter's actual EPS vs that quarter's consensus (from step 1 historical data)
   - Count consecutive beats/misses
   - ⚠️ If 4+ consecutive beats -> market expects a beat, whisper number is 2-5% above consensus; a mere "inline" beat may trade like a miss
   - ⚠️ If 2+ consecutive misses with downward revisions -> negative revision cycle, de-rate risk
   - 💡 Cross-reference: beat magnitude trending smaller each Q -> "beat fatigue", re-rate ceiling forming

3. **Pre-earnings IV & straddle pricing** `fin_derivatives(endpoint="options/chains", symbol="AAPL")` — Get ATM options near next expiry
   - Calculate ATM straddle price = (ATM Call + ATM Put) / Stock Price = implied move %
   - Get current IV and compare to 30-day historical IV -> IV percentile
   - ⚠️ If IV percentile > 80th -> premium expensive, selling premium (short straddle/strangle) has edge IF expected move < implied move
   - ⚠️ If IV percentile < 40th -> unusual for pre-earnings, possible complacency or low-vol name
   - 💡 Compare implied move vs actual moves from last 4 earnings (step 2 price data): implied > average actual -> sell bias; implied < average actual -> buy bias

4. **Post-earnings price reaction** `fin_stock(endpoint="price/historical", symbol="AAPL", limit=60, provider="yfinance")` — Analyze open-to-open moves on earnings days
   - For each of last 8 earnings dates: Gap % = (Next-day Open - Prior Close) / Prior Close
   - Build reaction table: Date | Actual EPS | Consensus | Beat/Miss | 1-day Move | 5-day Move
   - ⚠️ If beat + price drops pattern (3 of last 4 Qs) -> "sell the news" regime, market pricing perfection
   - ⚠️ If miss + price rises pattern -> market looking through to forward guidance
   - 💡 Large gap (>5%) after earnings fills only ~40% within 30 days vs common gaps (~70% fill in 3 days)

5. **Earnings surprise quantification**
   - Surprise % = (Actual EPS - Consensus EPS) / |Consensus EPS| \* 100
   - Revenue surprise % = (Actual Revenue - Consensus Revenue) / Consensus Revenue \* 100
   - ⚠️ If EPS beat but Revenue miss -> cost-cutting driven, not sustainable growth
   - ⚠️ If Revenue beat but EPS miss -> investment phase (bullish if margin trajectory intact)
   - 💡 Cross-validate with step 4: large positive surprise + negative price reaction = high bar already embedded

6. **Earnings season dashboard** (when user asks about overall season)
   - Identify current season phase (early/mid/late) based on calendar
   - Estimate sector-level beat rates from mega-cap bellwethers already reported
   - 💡 If bank earnings (JPM/GS) set negative tone -> historically drags sentiment for 1-2 weeks
   - 💡 If mega-cap tech all beat -> risk-on for rest of season, but concentration risk caveat

## Data Notes

- **Earnings calendar**: No dedicated calendar API. Use `fundamental/earnings_forecast` revision spikes + seasonal pattern (Jan/Apr/Jul/Oct) as proxy. Mega-cap dates are well-known and can be stated.
- **US quotes**: yfinance, ~15min delay. Use `provider="yfinance"` for `price/historical`.
- **Consensus EPS**: `fundamental/earnings_forecast` (tushare). Small-cap (<$2B) may lack analyst coverage.
- **Options chains**: yfinance, ~15min delay. Greeks included (Delta/Gamma/Vega/Theta/IV).
- **Whisper numbers**: Not available via API. Approximate as consensus + 2-5% for mega-cap names with strong beat streaks.
- **Guidance**: Structured guidance data not available. Infer from `us/income` revenue trajectory and `earnings_forecast` revision direction.

## Response Guidelines

### Dollar Format

- EPS: $1.52 / -$0.08 (2 decimal places, always show sign for surprise)
- Revenue: $94.3B / $2.1B (use $B/$M shorthand)
- Stock price: $192.53 (2 decimal places)
- Surprise: +4.2% / -1.8% (always show +/- sign)
- IV: 45.2% (1 decimal place)
- Implied move: +/-3.8% (show as range)

### Must Include

- Data cutoff date ("Data as of 2026-03-07")
- Consensus source note when citing EPS estimates
- Beat/miss streak count (e.g., "Beat 6 of last 8 quarters")
- Pre-earnings: days until report + market session (before/after market)
- Post-earnings: actual vs consensus + surprise % + price reaction

### Display Format

- Single stock earnings deep-dive -> structured sections: Consensus | Beat/Miss History | IV Analysis | Price Reaction Table
- Beat/miss history -> table with columns: Quarter | Actual EPS | Consensus | Surprise % | 1-Day Move
- Earnings season overview -> sector-level summary table
- Pre-earnings options -> show implied move vs historical average move comparison
- Always end with actionable insight: "Based on patterns, key risk/opportunity is..."
