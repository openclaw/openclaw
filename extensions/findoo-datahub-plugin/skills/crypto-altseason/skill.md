---
name: fin-crypto-altseason
description: "Crypto altseason timing — BTC dominance trend, Altseason Index (Top 50 vs BTC), ETH/BTC ratio, category rotation radar, capital rotation ladder (BTC→ETH→large ALT→mid-cap→meme). Use when: user asks about altseason, BTC dominance direction, ETH/BTC ratio, altcoin rotation, or 'should I switch from BTC to alts'. NOT for: BTC cycle analysis (use fin-crypto-btc-cycle), single coin lookup (use fin-crypto), DeFi yields (use fin-crypto-defi-yield), funding rate arbitrage (use fin-crypto-funding-arb)."
metadata: { "openclaw": { "emoji": "🔄", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Crypto Altseason Timing

BTC dominance is the traffic light for altseason. This skill turns "feels like alts are pumping" into a quantifiable, actionable rotation timing system.

> **Scope boundary:** This skill covers BTC→ALT capital rotation timing. For BTC's own halving cycle, use `/fin-crypto-btc-cycle`. For single-coin fundamental analysis, use `/fin-crypto`. For DeFi protocol yields, use `/fin-crypto-defi-yield`.

## When to Use

- "现在是山寨季吗" / "Is it altseason?"
- "BTC dominance 在下降意味着什么" / "BTC dominance is dropping, what does it mean?"
- "ETH/BTC 汇率怎么看" / "How is ETH/BTC doing?"
- "该从 BTC 换到山寨了吗" / "Should I rotate from BTC to alts?"
- "哪个赛道最近涨得好" / "Which crypto sector is pumping?"
- "山寨季什么时候结束" / "When does altseason end?"
- "大盘币 vs 小盘币表现" / "Large cap vs small cap crypto performance"

## When NOT to Use

- BTC 减半周期 / BTC halving cycle positioning → use `/fin-crypto-btc-cycle`
- 单币查价 / 协议分析 / CEX 行情 → use `/fin-crypto`
- DeFi 收益对比 / yield farming → use `/fin-crypto-defi-yield`
- 资金费率套利 → use `/fin-crypto-funding-arb`
- 稳定币资金流分析 → use `/fin-crypto-stablecoin-flow`
- 宏观利率对 crypto 影响 → use `/fin-crypto-macro-bridge`
- 美股行业轮动 → use `/fin-us-sector-rotation`

## Tools & Parameters

### fin_crypto — Core data

| Parameter | Type   | Required | Format              | Default | Example           |
| --------- | ------ | -------- | ------------------- | ------- | ----------------- |
| endpoint  | string | Yes      | see endpoints below | —       | coin/global_stats |
| symbol    | string | Depends  | pair / coin ID      | —       | ETH/BTC           |
| limit     | number | No       | 1-250               | 100     | 50                |

#### Key Endpoints

| endpoint              | Description                  | Example                                                              |
| --------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `coin/global_stats`   | BTC dominance (current snap) | `fin_crypto(endpoint="coin/global_stats")`                           |
| `coin/market`         | Top N coins by market cap    | `fin_crypto(endpoint="coin/market", limit=50)`                       |
| `coin/categories`     | Category/sector 7d% rankings | `fin_crypto(endpoint="coin/categories")`                             |
| `coin/trending`       | Trending / hot coins         | `fin_crypto(endpoint="coin/trending")`                               |
| `defi/chains`         | Chain-level TVL (ecosystem)  | `fin_crypto(endpoint="defi/chains")`                                 |
| `market/funding_rate` | Funding rate (sentiment)     | `fin_crypto(endpoint="market/funding_rate", symbol="ETH/USDT:USDT")` |

### fin_data_ohlcv — ETH/BTC K-line

| Parameter | Type   | Required | Default | Example |
| --------- | ------ | -------- | ------- | ------- |
| symbol    | string | Yes      | —       | ETH/BTC |
| market    | string | No       | crypto  | crypto  |
| timeframe | string | No       | 1d      | 1d      |
| limit     | number | No       | 200     | 90      |

### Auxiliary Tools

| tool              | use case                                         |
| ----------------- | ------------------------------------------------ |
| `fin_ta`          | RSI/SMA/MACD on ETH/BTC for trend confirmation   |
| `fin_data_regime` | BTC regime (bull/bear) as altseason prerequisite |

## Altseason Analysis Pattern

### 1. BTC Dominance Assessment

1. **BTC Dominance snapshot** `fin_crypto(endpoint="coin/global_stats")` — Get current btc_dominance %
   - ⚠️ `coin/global_stats` returns a single snapshot, NOT historical series. To assess trend, compare with known recent values or use BTC market cap / total market cap from `coin/market`
   - 💡 BTC dominance is the single most important altseason indicator

2. **BTC + market context** `fin_crypto(endpoint="coin/market", limit=50)` — Top 50 coin performance
   - Calculate: how many of Top 50 (excluding stablecoins) outperformed BTC over 7d/30d
   - ⚠️ This is the Altseason Index calculation basis

### 2. Altseason Index (Self-Calculated)

```
Count coins in Top 50 (excluding stablecoins + wrapped tokens) that outperformed BTC in 7d return.
Altseason Index = outperformers / eligible_count × 100

Interpretation:
  > 75% = Altseason confirmed (strong rotation out of BTC)
  50-75% = Transitional (rotation beginning)
  25-50% = Neutral (mixed signals)
  < 25% = Bitcoin Season (BTC dominates, alts lag)
```

### 3. Rotation Ladder Detection

```
BTC → ETH → Large ALT → Mid-cap ALT → Meme → TOP signal

Step 1: fin_data_ohlcv(symbol="ETH/BTC", market="crypto", timeframe="1d", limit=30) → ETH/BTC trend
Step 2: fin_ta(indicator="rsi", symbol="ETH/BTC", market="crypto") → momentum
Step 3: fin_crypto(coin/market, limit=50) → stratify by market cap tiers:
  - Tier 1 (>$50B): BTC, ETH
  - Tier 2 ($10-50B): SOL, BNB, XRP, ADA, AVAX, DOT
  - Tier 3 ($1-10B): mid-cap alts
  - Tier 4 (<$1B): small-cap / meme
```

Rotation signal progression:

- ⚠️ ETH/BTC breaking downtrend + RSI >50 = Rotation from BTC to ETH (Phase 1)
- ⚠️ Tier 2 avg 7d return > BTC 7d return = Large-cap rotation (Phase 2)
- ⚠️ Tier 3 avg 7d return > Tier 2 = Mid-cap rotation (Phase 3)
- ⚠️ Meme category 7d% > +30% = Late-stage euphoria (Phase 4 — caution!)
- 💡 Cross-validate with funding rate: ETH funding turning positive while BTC funding neutral = capital migrating

### 4. Category Rotation Radar

1. **Sector rankings** `fin_crypto(endpoint="coin/categories")` — 7d% by category
   - Top 5 categories by 7d performance = current hot sectors
   - ⚠️ If Meme category leads for 2+ consecutive weeks = late-stage warning
   - 💡 Cross-validate with `defi/chains`: if a category's chain TVL is also growing, the rotation has fundamental support

2. **Ecosystem validation** `fin_crypto(endpoint="defi/chains")` — Chain-level TVL
   - Rising TVL on alt-L1/L2 chains = capital migration to altcoin ecosystems
   - ⚠️ TVL rising but fees flat (from `defi/fees`) = incentive-driven, not organic

### 5. Altseason Health Check (Composite)

```
Combine signals into a composite score (0-5):

1. BTC dom trending down (7d) .............. +1
2. Altseason Index > 50% ................... +1
3. ETH/BTC in uptrend (above 20d SMA) ...... +1
4. Top category 7d% > +15% ................. +1
5. Meme category NOT leading ............... +1

Score interpretation:
  5/5 = Strong healthy altseason (rotate aggressively)
  3-4 = Altseason developing (start positioning)
  1-2 = Early / mixed signals (selective, stick to large caps)
  0   = Bitcoin Season (stay in BTC or sidelines)
```

## Signal Quick-Reference

### BTC Dominance + BTC Price Matrix

| BTC Dominance | BTC Price | Signal          | Action                                |
| ------------- | --------- | --------------- | ------------------------------------- |
| dom ↓         | BTC ↑     | Altseason onset | Rotate BTC → ETH → ALT progressively  |
| dom ↓         | BTC ↓     | Panic exit      | Risk-off, move to stablecoins         |
| dom ↑         | BTC ↑     | Bitcoin Season  | Concentrate in BTC, trim alts         |
| dom ↑         | BTC ↓     | ALT hemorrhage  | Worst scenario for alts, full defense |

Threshold: dom 7d change > ±0.5% = trend signal; > ±2% = strong signal.

### ETH/BTC as Leading Indicator

ETH/BTC is the most reliable altseason leading indicator:

- Breaking multi-month downtrend = altseason confirmation
- New 90-day high = altseason acceleration
- Divergence (ETH/BTC dropping while small alts pump) = unhealthy, likely reversal soon

### Altseason End Signals

| Signal                            | Severity | Detection                               |
| --------------------------------- | -------- | --------------------------------------- |
| Meme category 7d% > +50%          | High     | `coin/categories` — euphoria peak       |
| BTC dom 7d increase > +2%         | High     | `coin/global_stats` — capital returning |
| ETH/BTC breaking below 20d SMA    | Medium   | `fin_ta(sma)` on ETH/BTC                |
| Funding rates > +0.10% on alts    | Medium   | `market/funding_rate` — crowded longs   |
| Top 50 outperformance drops < 40% | Medium   | Altseason Index reversal                |

## Data Notes

- **BTC Dominance**: `coin/global_stats` provides a single current snapshot. There is NO historical dominance API. To track trend, the skill relies on comparing the current value against recent snapshots or computing BTC mcap / total mcap from `coin/market`.
- **CoinGecko**: ~30 req/min rate limit. `coin/categories` updates daily. Use 7d% for rotation signals.
- **ETH/BTC OHLCV**: Available via `fin_data_ohlcv(symbol="ETH/BTC", market="crypto")`. Sufficient for trend analysis.
- **Category data**: CoinGecko categories may not perfectly map to investment themes. Cross-validate with TVL data from `defi/chains`.
- **Altseason Index**: Self-calculated from `coin/market` Top 50 data. This is a simplified version of the Blockchain Center Altseason Index.

## Response Guidelines

### Number Formats

- BTC dominance: 54.3% (1 decimal)
- Altseason Index: 68% (integer)
- ETH/BTC ratio: 0.0542 (4 decimals)
- Category 7d%: +28.5% / -3.2% (always with +/- sign, 1 decimal)
- Market cap tiers: $45.2B / $3.8B / $280M (use $B/$M)

### Must Include

- Data timestamp ("Data as of YYYY-MM-DD")
- Current BTC dominance with directional context
- Altseason Index score with interpretation
- Rotation ladder current phase
- At least one ⚠️ risk signal assessment

### Display Format

- Altseason assessment → structured sections: Dominance, Altseason Index, ETH/BTC, Category Top 5, Composite Score, Action
- Category rotation → ranked table (category, 7d%, market cap, interpretation)
- ETH/BTC analysis → trend direction + RSI + key levels + historical context
- Always end with actionable recommendation tied to composite score
