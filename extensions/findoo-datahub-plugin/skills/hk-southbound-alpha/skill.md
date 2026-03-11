---
name: fin-hk-southbound-alpha
description: "Southbound capital alpha — daily/monthly net buy trends, accumulation signals (5-day streak, single-day spike), sector attribution, contrarian bottom-fishing indicator. Use when: user asks about southbound flow trends, mainland money into HK, Stock Connect net buy, smart money signal. NOT for: individual HK stock analysis (use fin-hk-stock), northbound flow into A-shares (use fin-a-northbound-decoder), HSI valuation (use fin-hk-hsi-pulse)."
metadata:
  { "openclaw": { "emoji": "\U0001F4B0", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Southbound Capital Alpha

Track mainland capital flowing into Hong Kong via Stock Connect. Transform southbound flow from a news headline number into an actionable investment signal with trend analysis, accumulation detection, and contrarian indicators.

## When to Use

- "南向资金今天买了多少" / "Southbound net buy today"
- "南向资金最近趋势" / "Southbound flow trend this month"
- "内地资金在买什么港股" / "What are mainland investors buying in HK?"
- "港股通净买入排名" / "Stock Connect top net buys"
- "南向资金连续流入说明什么" / "What does consecutive southbound inflow mean?"
- "南向大量卖出后恒指走势" / "HSI performance after heavy southbound selling"

## When NOT to Use

- 单只港股基本面分析 (00700.HK 财报) → use `/fin-hk-stock`
- 北向资金 (外资买 A 股) → use `/fin-a-northbound-decoder`
- 恒指估值分位 / 恒指便不便宜 → use `/fin-hk-hsi-pulse`
- 港股高息股筛选 → use `/fin-hk-dividend-harvest`
- 中概互联网板块分析 → use `/fin-hk-china-internet`
- A 股全市场雷达 (龙虎榜/涨停) → use `/fin-a-share-radar`
- 宏观利率 (HIBOR/Fed) → use `/fin-macro`

## Tools & Parameters

### fin_market — Southbound flow data

| Parameter  | Type   | Required | Format     | Default | Example        |
| ---------- | ------ | -------- | ---------- | ------- | -------------- |
| endpoint   | string | Yes      | see below  | —       | flow/ggt_daily |
| start_date | string | No       | YYYY-MM-DD | —       | 2026-01-01     |
| end_date   | string | No       | YYYY-MM-DD | —       | 2026-03-07     |
| limit      | number | No       | 1-5000     | 200     | 60             |

#### Endpoints

| endpoint           | Description                        | Example                                             |
| ------------------ | ---------------------------------- | --------------------------------------------------- |
| `flow/ggt_daily`   | Daily southbound net buy (HKD)     | `fin_market(endpoint="flow/ggt_daily", limit=60)`   |
| `flow/ggt_monthly` | Monthly southbound summary         | `fin_market(endpoint="flow/ggt_monthly", limit=12)` |
| `flow/hs_const`    | Stock Connect constituent universe | `fin_market(endpoint="flow/hs_const")`              |

### fin_stock — Price verification

| Parameter | Type   | Required | Format    | Default | Example          |
| --------- | ------ | -------- | --------- | ------- | ---------------- |
| symbol    | string | Yes      | XXXXX.HK  | —       | 00700.HK         |
| endpoint  | string | Yes      | see below | —       | price/historical |
| limit     | number | No       | 1-5000    | 200     | 20               |

#### Endpoints

| endpoint           | Description      | Example                                                               |
| ------------------ | ---------------- | --------------------------------------------------------------------- |
| `price/historical` | OHLCV for stocks | `fin_stock(symbol="00700.HK", endpoint="price/historical", limit=20)` |

### fin_index — Benchmark

| endpoint           | Description           | Example                                                          |
| ------------------ | --------------------- | ---------------------------------------------------------------- |
| `price/historical` | HSI price for overlay | `fin_index(symbol="HSI", endpoint="price/historical", limit=60)` |

## Southbound Capital Analysis Pattern

1. **Daily flow dashboard** `fin_market(endpoint="flow/ggt_daily", limit=60)` — Get last 60 trading days of southbound net buy
   - Compute: 5-day / 10-day / 20-day moving average of net buy
   - Compute: today's net buy vs 20-day average ratio
   - ⚠️ If single-day net buy > 3x the 20-day average → "institutional surge" signal, historically precedes 2-4 week rallies
   - ⚠️ If net buy > 10B HKD in a single day → "major bottom-fishing" event
   - ⚠️ If 5 consecutive days net buy > 5B HKD total → "trend allocation" mode
   - 💡 Distinguish between Shanghai-HK Connect and Shenzhen-HK Connect flows if available — divergence indicates sector preference (SH = financials/energy, SZ = tech/consumer)

2. **Monthly trend** `fin_market(endpoint="flow/ggt_monthly", limit=12)` — 12-month trend context
   - ⚠️ If 3+ consecutive months net inflow → structural allocation trend, not tactical
   - ⚠️ If monthly flow reverses from net sell to net buy → potential inflection point
   - 💡 Overlay with HSI returns (step 5): flow leads price by 1-2 weeks historically

3. **Accumulation signal scoring** — Combine daily signals into a composite score
   - **Level 1** (Mild): 3-day cumulative net buy > 0 → normal
   - **Level 2** (Notable): 5-day cumulative > 10B HKD → attention
   - **Level 3** (Strong): 5-day cumulative > 20B HKD + single day > 3x avg → high conviction
   - **Level 4** (Extreme): 10-day cumulative > 30B HKD → rare, historically 3 times in past 3 years
   - ⚠️ Level 3/4 signals: HSI median 20-day forward return historically +3.2%

4. **Sector attribution (degraded mode)** — Infer sector flow direction
   - Since `flow/ggt_top10` (individual stock net buy) is unavailable, use proxy:
   - Step 4a: On days with large southbound inflow, check volume spikes in key stocks:
     `fin_stock(symbol="00700.HK", endpoint="price/historical", limit=5)` — Tencent (tech)
     `fin_stock(symbol="00941.HK", endpoint="price/historical", limit=5)` — China Mobile (telecom/dividend)
     `fin_stock(symbol="00883.HK", endpoint="price/historical", limit=5)` — CNOOC (energy/dividend)
     `fin_stock(symbol="09988.HK", endpoint="price/historical", limit=5)` — Alibaba (tech)
   - ⚠️ If tech names (00700/09988/03690) volume spike on high-inflow day → "growth allocation"
   - ⚠️ If dividend names (00941/00883/01398) volume spike → "defensive/yield allocation"
   - 💡 Cross-ref with `/fin-hk-china-internet` for deeper sector analysis when tech inflows dominate

5. **HSI overlay** `fin_index(symbol="HSI", endpoint="price/historical", limit=60)` — Validate flow-to-price transmission
   - Compute: correlation between 5-day cumulative net buy and HSI 5-day forward return
   - ⚠️ If flow positive but HSI still declining → "absorption phase", smart money buying into weakness
   - ⚠️ If flow negative but HSI rising → rally on thin support, caution
   - 💡 Cross-ref `/fin-hk-hsi-pulse` for valuation context: strong inflow + deep value PE = highest conviction buy signal

6. **Contrarian indicator** — Extreme selling as bottom signal
   - Historical pattern: when southbound sells consecutively for 5+ days with cumulative >10B HKD outflow, HSI 20-day forward return median +4.1% (panic selling = contrarian buy)
   - ⚠️ If consecutive net sell > 5 days → flag as "contrarian opportunity" with caveats
   - ⚠️ Contrarian signal invalid if selling is driven by structural change (e.g., policy shock, not just sentiment)
   - 💡 Validate with `/fin-hk-hsi-pulse` ERP: panic selling + ERP > 5% = strongest contrarian signal

## Signal Quick-Reference

| Pattern                           | Daily/Cumulative | Signal                     | Historical Forward Return |
| --------------------------------- | ---------------- | -------------------------- | ------------------------- |
| Single day > 10B HKD              | Daily            | Major bottom-fishing       | +4.5% / 20d               |
| 5-day cumulative > 20B HKD        | 5-day            | Strong trend allocation    | +3.2% / 20d               |
| Single day > 3x 20-day average    | Daily vs avg     | Institutional surge        | +2.8% / 20d               |
| 3+ months consecutive net inflow  | Monthly          | Structural allocation      | +8-12% / 3M               |
| 5+ days consecutive net sell >10B | 5-day            | Contrarian buy opportunity | +4.1% / 20d               |
| Flow positive + HSI declining     | Mixed            | Absorption phase           | Monitor for breakout      |

## Data Notes

- **ggt_daily**: tushare, EOD update (available to 2026-03-05), contains total southbound net buy/sell in HKD
- **ggt_monthly**: tushare, monthly aggregation, best for trend analysis
- **ggt_top10**: individual stock net buy data — CURRENTLY UNAVAILABLE (timeout), use volume proxy instead
- **hs_const**: Connect-eligible stock list, updated semi-annually
- **Sector attribution**: degraded mode (volume proxy) — accuracy ~60-70% vs ideal (stock-level flow data)
- **Flow timing**: EOD data, not intraday — cannot capture morning vs afternoon flow shifts
- **Missing**: individual stock-level southbound net buy/sell, ETF-level southbound flow (2840.HK/3188.HK), CCASS participant-level changes

## Response Guidelines

### Number Format

- Net buy amount: 68.3 亿 HKD (1 decimal, always specify HKD)
- Cumulative flow: 312 亿 HKD (integer for large amounts)
- Moving average: 45.6 亿 HKD (1 decimal)
- Ratio: 3.2x (1 decimal + "x")
- Returns: +3.2% / -1.8% (always signed)
- Consecutive days: 7 个交易日 (specify trading days)

### Must Include

- Data cutoff date ("数据截至 YYYY-MM-DD")
- Today's net buy + 5/10/20-day moving average comparison
- Signal level (1-4) based on accumulation scoring
- Sector attribution (even if degraded/proxy-based, label it as estimate)
- At least one historical analogy for context
- Caveat: southbound flow is ONE signal, not a standalone buy/sell indicator

### Display Format

- Lead with today's headline number + signal level (1 sentence)
- Flow trend table: last 5 trading days with daily net buy + cumulative
- Moving average comparison: 5d/10d/20d MA with trend arrows
- Monthly trend: 3-month summary with HSI return overlay
- Sector attribution: pie chart description (tech X% / dividend Y% / other Z%) with proxy caveat
- End with actionable interpretation: what does this flow pattern historically predict?
