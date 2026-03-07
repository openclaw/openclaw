---
name: fin-hk-hsi-pulse
description: "HSI valuation pulse — PE/PB percentile, equity risk premium (ERP = 1/PE - HIBOR), historical bottom analogy, regime overlay. Use when: user asks if HK market is cheap, HSI valuation, Hang Seng PE percentile, whether to bottom-fish HK. NOT for: individual HK stocks (use fin-hk-stock), A-shares (use fin-a-share), US stocks (use fin-us-equity), southbound flow (use fin-hk-stock)."
metadata:
  { "openclaw": { "emoji": "\U0001F4C9", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# HSI Valuation Pulse

Quantify whether the Hang Seng Index is cheap or expensive using PE/PB percentiles, equity risk premium, and historical bottom analogies. Turns "is HK cheap?" from gut feeling into a data-anchored judgment.

## When to Use

- "港股现在便宜吗" / "Is the Hang Seng cheap?"
- "恒指估值分位" / "HSI PE percentile"
- "恒指 PE 多少" / "HSI valuation"
- "该不该抄底港股" / "Should I bottom-fish HK?"
- "恒指什么时候这么便宜过" / "When was HSI this cheap historically?"
- "恒指成分股有多少破净" / "How many HSI constituents trade below book?"

## When NOT to Use

- 单只港股分析 (00700.HK 财报/估值) → use `/fin-hk-stock`
- A 股指数估值 (沪深300 PE) → use `/fin-a-share`
- 美股大盘估值 (S&P 500) → use `/fin-us-equity`
- 南向资金流向 → use `/fin-hk-stock`
- 港股高息股筛选 → use `/fin-hk-dividend-harvest`
- 宏观经济数据 (GDP/CPI) → use `/fin-macro`
- 联系汇率压力 / HIBOR → use `/fin-macro`

## Tools & Parameters

### fin_index — HSI valuation data

| Parameter  | Type   | Required | Format     | Default | Example     |
| ---------- | ------ | -------- | ---------- | ------- | ----------- |
| symbol     | string | Yes      | HSI        | —       | HSI         |
| endpoint   | string | Yes      | see below  | —       | daily_basic |
| start_date | string | No       | YYYY-MM-DD | —       | 2016-01-01  |
| end_date   | string | No       | YYYY-MM-DD | —       | 2026-03-07  |
| limit      | number | No       | 1-5000     | 200     | 2500        |

#### Endpoints

| endpoint           | Description                   | Example                                                           |
| ------------------ | ----------------------------- | ----------------------------------------------------------------- |
| `daily_basic`      | HSI PE/PB/DY history          | `fin_index(symbol="HSI", endpoint="daily_basic", limit=2500)`     |
| `price/historical` | HSI price (close/open/volume) | `fin_index(symbol="HSI", endpoint="price/historical", limit=250)` |
| `constituent`      | HSI constituent stocks (~82)  | `fin_index(symbol="HSI", endpoint="constituent")`                 |

### fin_macro — Rate environment

| endpoint      | Description           | Example                             |
| ------------- | --------------------- | ----------------------------------- |
| `hibor`       | HIBOR (HKD interbank) | `fin_macro(endpoint="hibor")`       |
| `treasury_us` | US Treasury yields    | `fin_macro(endpoint="treasury_us")` |

### fin_data_regime — Market regime

| Parameter | Type   | Required | Example |
| --------- | ------ | -------- | ------- |
| symbol    | string | Yes      | HSI     |
| market    | string | Yes      | equity  |

## HSI Valuation Analysis Pattern

1. **Valuation snapshot** `fin_index(symbol="HSI", endpoint="daily_basic", limit=2500)` — Get PE/PB/DY history for percentile calculation
   - Compute current PE/PB percentile over 10Y window
   - ⚠️ If PE < 10th percentile (~8x) → "deep value" zone, historically rare
   - ⚠️ If PB < 1.0x (below book) → extreme pessimism, occurred only in 2008/2016/2022 bottoms
   - 💡 PE percentile alone is insufficient — must cross-check with ERP (step 3)

2. **Price context** `fin_index(symbol="HSI", endpoint="price/historical", limit=250)` — Current price level, drawdown from peak, YTD return
   - ⚠️ If HSI drawdown from 52-week high > 20% → bear market territory
   - 💡 Cross-ref with step 1: deep value PE + large drawdown = historically strong buy signal (but may persist)

3. **Equity Risk Premium (ERP)** `fin_macro(endpoint="hibor")` — HIBOR as risk-free rate proxy
   - Formula: `ERP = (1/PE) - HIBOR_3M`
   - HSI 10Y average ERP ~3.5-4.0%
   - ⚠️ If ERP > 5% → risk compensation is generous, equity attractive vs deposits
   - ⚠️ If ERP < 2% → stocks not compensating for risk, bonds may be better
   - 💡 Also fetch `fin_macro(endpoint="treasury_us")` for global rate anchor; if US 10Y > 4.5%, high rates globally suppress equity valuations

4. **Cheap-for-a-Reason check** — Diagnose WHY it's cheap before concluding "buy"
   - High HIBOR (Fed tightening) → liquidity drain, valuation compression is mechanical
   - Earnings downgrade cycle → low PE may be "value trap" if E is about to drop
   - Geopolitical/policy risk → structural discount (not mean-reverting)
   - Capital outflow (southbound selling) → sentiment-driven, more likely to revert
   - ⚠️ If multiple "cheap-for-a-reason" factors active → label as "cheap but catalysts absent, may stay cheap longer"

5. **Market regime overlay** `fin_data_regime(symbol="HSI", market="equity")` — Trend direction
   - 💡 Combine regime + valuation:
     - Deep value + bullish trending = **strong buy signal**
     - Deep value + bearish trending = **accumulate cautiously / wait for regime flip**
     - Fair value + bullish = **hold / momentum play**
     - Expensive + any regime = **reduce**

6. **Historical bottom analogy** — Compare current PE/PB to known bottoms
   - Reference bottoms: 2008 GFC (PE ~7x, PB ~0.85), 2016 China scare (PE ~8.5x, PB ~0.9), 2022 Covid/regulation (PE ~8x, PB ~0.8)
   - Post-bottom returns: 2008→+52% in 1Y; 2016→+36% in 1Y; 2022→+28% in 6M
   - ⚠️ Past performance ≠ future results — always caveat
   - 💡 If current valuation matches a historical bottom but ERP is lower than at that bottom → less attractive than headline suggests

7. **Constituent breadth** `fin_index(symbol="HSI", endpoint="constituent")` + batch `fin_stock(endpoint="fundamental/ratios")` — How many are cheap
   - Count: PE <10x, PB <1x, DY >5% among ~82 constituents
   - ⚠️ If >50% of constituents PE <10x → broad-based cheapness, not just one sector dragging index
   - 💡 Sector breakdown (banks/energy/tech/property) reveals whether cheapness is concentrated or dispersed

## Signal Quick-Reference

| HSI PE (10Y ptile) | PB      | ERP vs 10Y avg | Regime  | Signal                      |
| ------------------ | ------- | -------------- | ------- | --------------------------- |
| < 10th (~8x)       | < 1.0   | ERP > 5%       | Any     | Deep value — accumulate     |
| 10-25th (~9-10x)   | ~1.0    | ERP 3.5-5%     | Bullish | Attractive — build position |
| 25-75th (~10-12x)  | 1.0-1.2 | ERP 2-3.5%     | Any     | Fair value — hold           |
| > 75th (~13x+)     | > 1.3   | ERP < 2%       | Any     | Expensive — trim            |

## Data Notes

- **HSI daily_basic**: tushare, EOD update, PE/PB/DY available back to ~2010
- **HIBOR**: daily, trading days only, tushare
- **US Treasury**: daily, tushare — use 10Y yield as global rate benchmark
- **HSI constituents**: ~82 stocks, rebalanced quarterly (Mar/Jun/Sep/Dec)
- **Regime detection**: algorithmic (trend + volatility), not a forecast
- **Missing**: HSTECH index valuation (new economy benchmark), constituent weights (cannot compute cap-weighted valuation precisely)

## Response Guidelines

### Number Format

- HSI level: 20,156.32 (comma-separated, 2 decimals)
- PE/PB: 9.8x / 0.92x (1 decimal + "x" suffix)
- Percentile: 18th percentile (integer + "th")
- ERP: 5.4% (1 decimal)
- HIBOR: 4.80% (2 decimals)
- Dividend yield: 3.85% (2 decimals)
- Returns: +52.3% / -18.7% (always signed)

### Must Include

- Data cutoff date ("data as of YYYY-MM-DD")
- PE AND PB percentiles (both, not just PE)
- ERP calculation with explicit formula shown
- At least one historical bottom comparison
- "Cheap-for-a-reason" diagnosis (never just say "it's cheap, buy")
- Regime label from fin_data_regime

### Display Format

- Lead with valuation verdict (1 sentence) before diving into data
- PE band table: current vs 10Y 10th/25th/50th/75th/90th percentiles
- Historical comparison table: current vs 2008/2016/2022 bottoms (PE, PB, ERP, post-recovery return)
- Constituent breadth stats: "X of 82 stocks PE <10x, Y stocks PB <1x"
- Always end with catalyst assessment: what could make cheap become "buy"
