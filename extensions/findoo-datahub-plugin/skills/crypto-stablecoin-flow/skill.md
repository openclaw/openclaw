---
name: fin-crypto-stablecoin-flow
description: "Stablecoin capital flow analysis — USDT/USDC/DAI market cap trends, 4-week rolling inflow as leading indicator, chain distribution (ETH/Tron/BSC), stablecoin-to-total-market ratio. Use when: user asks about stablecoin supply, capital inflow/outflow, OTC demand, USDT vs USDC comparison, or whether money is entering crypto. NOT for: individual coin analysis (use fin-crypto), DeFi yield farming (use fin-crypto), macro rates (use fin-macro)."
metadata: { "openclaw": { "emoji": "💵", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Stablecoin Capital Flow Analysis

Stablecoins = crypto market's M2 money supply. Track stablecoin flows as a **2-4 week leading indicator** for BTC and altcoin price direction.

> **Core thesis:** Capital enters crypto in three steps: fiat -> stablecoin -> BTC/altcoin. Stablecoin supply changes signal capital intent before price moves.

## When to Use

- "USDT 市值在增长吗" / "Is USDT market cap growing"
- "稳定币总量是多少" / "Total stablecoin supply"
- "场外资金在进场吗" / "Is money flowing into crypto"
- "USDT 和 USDC 有什么区别" / "USDT vs USDC comparison"
- "稳定币在哪条链上最多" / "Which chain has the most stablecoins"
- "现在是入场好时机吗" / "Is this a good time to enter crypto"

## When NOT to Use

- Individual coin price/analysis (BTC/ETH/SOL) -> use `/fin-crypto`
- DeFi protocol TVL/yields -> use `/fin-crypto`
- CEX trading (orderbook/funding rate) -> use `/fin-crypto`
- Macro interest rates/treasury yields -> use `/fin-macro`
- A-share/US equity -> use `/fin-a-share` or `/fin-us-equity`

## Tools & Parameters

### fin_crypto

| Parameter | Type   | Required | Format              | Default | Example          |
| --------- | ------ | -------- | ------------------- | ------- | ---------------- |
| endpoint  | string | Yes      | see endpoints below | —       | defi/stablecoins |
| symbol    | string | Depends  | coin ID / pair      | —       | bitcoin          |
| limit     | number | No       | 1-250               | 100     | 20               |

#### Key Endpoints

| endpoint            | Description                                      | Example                                        |
| ------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `defi/stablecoins`  | All stablecoins: market cap + chain distribution | `fin_crypto(endpoint="defi/stablecoins")`      |
| `coin/global_stats` | Total crypto market cap (for ratio calc)         | `fin_crypto(endpoint="coin/global_stats")`     |
| `coin/market`       | Top coins by market cap (BTC price ref)          | `fin_crypto(endpoint="coin/market", limit=10)` |
| `defi/chains`       | Per-chain TVL (cross-validate fund flow)         | `fin_crypto(endpoint="defi/chains")`           |
| `defi/bridges`      | Cross-chain bridge volumes (migration)           | `fin_crypto(endpoint="defi/bridges")`          |

### Auxiliary Tools

| tool              | use case                              |
| ----------------- | ------------------------------------- |
| `fin_data_ohlcv`  | BTC/ETH price overlay for correlation |
| `fin_data_regime` | Current market regime context         |
| `fin_ta`          | BTC trend confirmation                |

## Stablecoin Flow Analysis Pattern

1. **Stablecoin Supply Snapshot** `fin_crypto(endpoint="defi/stablecoins")` — Total supply + per-coin breakdown
   - Key fields: total mcap, USDT mcap, USDC mcap, DAI mcap, chain distribution per coin
   - ⚠️ If total stablecoin mcap < previous known value -> capital outflow signal, check severity
   - 💡 USDT growth = primarily Asian retail/OTC inflow; USDC growth = institutional/DeFi allocation

2. **Total Market Context** `fin_crypto(endpoint="coin/global_stats")` — Crypto total market cap + BTC dominance
   - Calculate: stablecoin_ratio = total_stablecoin_mcap / total_crypto_mcap
   - ⚠️ Ratio rising (e.g., 9% -> 12%) = capital retreating to sidelines (defensive)
   - ⚠️ Ratio falling (e.g., 12% -> 9%) = capital deploying into risk assets (offensive)
   - 💡 Cross-validate with BTC dominance: stablecoin ratio down + BTC dom down = broad risk-on (altseason fuel)

3. **Chain Distribution Analysis** `fin_crypto(endpoint="defi/stablecoins")` — Per-chain stablecoin breakdown
   - Ethereum = institutional DeFi + lending protocols
   - Tron = Asian OTC + cross-border remittance + retail
   - BSC = retail DeFi + gaming
   - Arbitrum/Base = L2 DeFi migration
   - ⚠️ If Tron USDT growing fastest -> Asian retail surge (historically bullish for BTC in 2-4 weeks)
   - ⚠️ If Ethereum USDC growing -> institutional positioning (larger but slower capital)
   - 💡 Bridge data (`defi/bridges`) cross-validates: net inflow to a chain confirms stablecoin migration direction

4. **BTC Price Correlation** `fin_crypto(endpoint="coin/market", limit=5)` + `fin_data_ohlcv(symbol="BTC/USDT")`
   - Compare stablecoin supply trend vs BTC 30-day price trend
   - ⚠️ Stablecoin supply rising + BTC flat/declining = accumulation phase (bullish setup)
   - ⚠️ Stablecoin supply declining + BTC rising = distribution/leverage-driven rally (fragile)
   - 💡 Historical pattern: stablecoin 4-week increase > $2B precedes BTC 30-day average gain of +12%

5. **USDT vs USDC Structural Analysis** — Derive from `defi/stablecoins` data
   - USDT/USDC ratio trend: rising = retail dominance; falling = institutional shift
   - ⚠️ USDT market share dropping below 60% = potential regulatory pressure signal
   - 💡 After major regulatory events (e.g., SEC actions), watch for USDT->USDC rotation

6. **Capital Flow Verdict** — Synthesize all signals
   - Strong inflow: 4w total increase > $2B + ratio declining + Tron USDT growing
   - Neutral: 4w change < $1B absolute, ratio stable
   - Outflow warning: 4w decrease > $1B + ratio rising + BTC price declining

## Leading Indicator Framework

### 4-Week Rolling Change Thresholds

| 4-Week Change | Signal           | Historical BTC 30d Avg | Action                        |
| ------------- | ---------------- | ---------------------- | ----------------------------- |
| > +$3B        | Strong inflow    | +15%                   | Bullish positioning warranted |
| +$1B to +$3B  | Moderate inflow  | +8%                    | Cautiously optimistic         |
| -$1B to +$1B  | Neutral          | +2%                    | No directional signal         |
| -$3B to -$1B  | Moderate outflow | -5%                    | Reduce leverage, raise cash   |
| < -$3B        | Capital flight   | -12%                   | Defensive mode, max caution   |

### Stablecoin/Market Cap Ratio Interpretation

| Ratio Range | State        | Meaning                              |
| ----------- | ------------ | ------------------------------------ |
| > 15%       | Max defense  | Heavy sideline capital, fear extreme |
| 10-15%      | Cautious     | Significant dry powder available     |
| 7-10%       | Balanced     | Capital actively deployed            |
| < 7%        | Full risk-on | Almost all capital in risk assets    |

## Data Notes

- **DefiLlama stablecoins**: No auth required, ~10min refresh cycle. Covers USDT/USDC/DAI/BUSD/TUSD and 20+ minor stablecoins
- **Chain distribution**: Per-coin per-chain breakdown available. Some smaller chains may have incomplete coverage
- **Missing data**: Mint/burn event stream (requires on-chain data — Tether Treasury/Circle), USDT OTC premium/discount (requires OTC desk quotes), historical time-series per chain (snapshot only, no built-in 4-week rolling — must compare against previous observation)
- **4-week rolling calculation**: Since `defi/stablecoins` returns a current snapshot, 4-week change requires comparing against a prior data point. If unavailable, state current absolute values and note the limitation
- **CoinGecko rate limit**: ~30 req/min for `coin/global_stats` and `coin/market`

## Response Guidelines

### Number Formats

- Stablecoin market cap: $168.2B (use $B for billions, $M for millions)
- Supply changes: +$1.8B / -$500M (always show +/- sign)
- Ratios: 9.8% (1 decimal place)
- BTC price: to nearest dollar ($67,432)
- Chain distribution: percentages with 1 decimal (Ethereum 45.2%, Tron 31.8%)

### Must Include

- Data timestamp ("Data as of YYYY-MM-DD")
- Top 3 stablecoins by market cap with individual figures
- Stablecoin/total crypto market cap ratio
- Chain distribution for at least top 3 chains
- Explicit note when 4-week rolling data is unavailable (snapshot limitation)

### Display Format

- Overview query -> summary paragraph + key metrics table
- USDT vs USDC comparison -> side-by-side table (market cap, growth, chain distribution, user profile)
- Capital flow analysis -> bullet-point signals with strength indicators
- Always end with a directional verdict: bullish / neutral / bearish with confidence level
- Include caveat: "Stablecoin flow is a leading indicator, not a guarantee. Always combine with price action and on-chain data for confirmation."
