---
name: fin-onchain
status: draft
description: "On-chain analytics - blockchain valuation metrics, DeFi protocol analysis, whale tracking, yield comparison, and token unlock impact assessment."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔗",
        "requires": { "extensions": ["findoo-trader-plugin", "findoo-datahub-plugin"] },
      },
  }
---

# On-Chain Analytics

Blockchain-native intelligence: on-chain valuation metrics, DeFi protocol risk scoring, whale movement tracking, yield farming comparison, and token unlock impact analysis.

## When to Use

**USE this skill when:**

- "NVT ratio for BTC" / "is ETH overvalued on-chain"
- "whale movements" / "who's accumulating BTC"
- "best DeFi yields" / "compare Aave vs Compound"
- "impermanent loss calculator"
- "token unlocks this month" / "SOL vesting schedule"
- "TVL trends" / "which protocols are growing"
- "stablecoin flows" / "USDT supply on Ethereum"
- "MVRV ratio" / "on-chain valuation"

## When NOT to Use

**DON'T use this skill when:**

- User wants traditional technical analysis -- use fin-expert
- User wants to execute a trade -- use fin-trading
- User wants portfolio P&L -- use fin-portfolio
- User wants news or sentiment -- use fin-news-intel
- User wants macro economic data -- use fin-macro-calendar

## Tools

### Existing Tools

- `fin_market_price` -- price and volume data for valuation ratio calculations
- `fin_ticker_info` -- market cap, circulating supply for NVT/MVRV context
- `fin_market_overview` -- broad market metrics for sector comparison

### On-Chain-Specific Tools (Documented)

- `fin_onchain_metrics` -- fetch blockchain valuation and activity metrics
  - Parameters: `asset` (BTC | ETH | etc), `metrics[]` (nvt | mvrv | sopr | puell | stablecoin_ratio | active_addresses | hash_rate)
  - Returns: current value, historical percentile, signal interpretation (overvalued/undervalued/neutral)

- `fin_defi_protocol` -- protocol-level analysis
  - Parameters: `protocol` (aave | compound | uniswap | lido | etc), `chain` (ethereum | arbitrum | polygon | etc)
  - Returns: TVL, TVL trend (7d/30d), revenue, fees, user count, audit status, governance token metrics

- `fin_defi_yields` -- compare yield farming opportunities
  - Parameters: `min_tvl` (default $1M), `chains[]` (filter by chain), `asset` (filter by deposit asset), `sort_by` (risk_adjusted_yield | apy | tvl)
  - Returns: ranked list with APY, TVL, risk score, IL exposure, audit status, net yield after IL

- `fin_whale_tracker` -- track large holder movements
  - Parameters: `asset`, `min_amount` (threshold for whale classification), `timeframe` (24h | 7d | 30d), `direction` (accumulation | distribution | all)
  - Returns: whale transactions list, net flow direction, exchange inflow/outflow, severity classification

- `fin_token_unlocks` -- upcoming token unlock schedule
  - Parameters: `asset` (optional, all if omitted), `timeframe` (7d | 30d | 90d)
  - Returns: unlock date, amount, percentage of circulating supply, recipient category (team/VC/community), daily volume comparison

## On-Chain Valuation Framework

### Key Metrics and Interpretation

| Metric                  | Formula                                  | Overvalued              | Fair Value | Undervalued                |
| ----------------------- | ---------------------------------------- | ----------------------- | ---------- | -------------------------- |
| NVT Ratio               | Network Value / Daily Transaction Volume | >95                     | 65-95      | <65                        |
| MVRV Ratio              | Market Cap / Realized Cap                | >3.5 (cycle top)        | 1.0-3.5    | <1.0 (cycle bottom)        |
| SOPR                    | Spent Output Profit Ratio                | >1.05 (profit taking)   | ~1.0       | <0.95 (capitulation)       |
| Puell Multiple          | Daily Issuance USD / 365-day MA          | >4.0 (top)              | 0.5-4.0    | <0.5 (bottom)              |
| Stablecoin Supply Ratio | BTC Market Cap / Stablecoin Supply       | High (low buying power) | --         | Low (dry powder available) |

### Signal Aggregation

Combine multiple metrics for higher-confidence signals:

- **Strong Buy**: 3+ metrics in undervalued zone simultaneously
- **Strong Sell**: 3+ metrics in overvalued zone simultaneously
- **Conflicting**: Mixed signals -- present each metric individually, do not force a consensus

## Whale Tracking

### Classification Tiers

| Tier        | BTC Amount       | ETH Amount         | Label                    |
| ----------- | ---------------- | ------------------ | ------------------------ |
| Mega Whale  | >10,000 BTC      | >100,000 ETH       | Institutional / Exchange |
| Large Whale | 1,000-10,000 BTC | 10,000-100,000 ETH | Fund / Major Holder      |
| Whale       | 100-1,000 BTC    | 1,000-10,000 ETH   | High Net Worth           |

### Movement Interpretation

- **Exchange to Wallet**: Accumulation signal -- removing from exchange reduces sell pressure
- **Wallet to Exchange**: Distribution signal -- depositing to exchange suggests intent to sell
- **Wallet to Wallet**: Neutral or OTC trade -- monitor but lower conviction
- **Exchange to Exchange**: Arbitrage or internal transfer -- generally noise

### Severity Assessment

Rate each whale movement by:

1. Size relative to daily volume (>10% = high impact)
2. Historical pattern of this wallet (serial seller vs long-term holder)
3. Current market context (whale selling during fear = more impactful)

## DeFi Yield Framework

### 7-Factor Risk-Adjusted Scoring

Each factor scored 0-10, weighted to produce a composite risk-adjusted yield score:

| Factor            | Weight | Scoring Criteria                                                                     |
| ----------------- | ------ | ------------------------------------------------------------------------------------ |
| APY               | 20%    | Higher = better, but flag >100% APY as likely unsustainable                          |
| TVL               | 20%    | >$100M = 10, $10M-100M = 7, $1M-10M = 4, <$1M = 1                                    |
| Audit Status      | 15%    | Multiple audits = 10, single audit = 7, unaudited = 2                                |
| Protocol Age      | 10%    | >2 years = 10, 1-2 years = 7, 6-12 months = 4, <6 months = 1                         |
| IL Risk           | 15%    | No IL (single-sided) = 10, low IL (stablecoin pair) = 7, high IL (volatile pair) = 3 |
| Chain Security    | 10%    | L1 mainnet = 10, established L2 = 7, new L2/sidechain = 4                            |
| IL-Adjusted Yield | 10%    | Net yield after estimated IL                                                         |

### Impermanent Loss Calculator

For liquidity provider positions:

```
IL = 2 * sqrt(price_ratio) / (1 + price_ratio) - 1
```

Where `price_ratio` = current_price / entry_price.

- Always show: gross APY, estimated IL, net yield (APY - IL)
- Flag when estimated IL exceeds 50% of APY -- the position may be net negative
- Compare net yield against simple staking or lending alternatives

## Token Unlock Impact Analysis

### Assessment Framework

For each upcoming unlock event, evaluate:

1. **Size Impact**: Unlock amount as % of circulating supply
   - > 5% = Major (likely significant selling pressure)
   - 2-5% = Moderate (notable but manageable)
   - <2% = Minor (likely absorbed by market)

2. **Recipient Category**:
   - Team/Founders: Higher sell probability (may need liquidity)
   - VC/Investors: High sell probability (mandate to return capital)
   - Community/Ecosystem: Lower sell probability (often staked or used)

3. **Volume Context**: Compare unlock value to 30-day average daily volume
   - If unlock > 5x daily volume: market cannot easily absorb
   - If unlock < 1x daily volume: likely absorbed without major impact

4. **Historical Unlock Behavior**: How did price react to previous unlocks for this token?

## Response Guidelines

- Lead with the most actionable insight -- don't bury the signal in data tables.
- For valuation metrics, always include the historical percentile (e.g., "NVT at 87, in the 92nd percentile historically").
- For whale tracking, separate signal from noise -- only highlight movements that exceed the significance threshold.
- For DeFi yields, always show the risk-adjusted ranking, not just raw APY. Sort by risk-adjusted yield by default.
- For IL calculations, show concrete dollar amounts, not just percentages.
- For token unlocks, create a calendar view with impact severity color coding.
- Cross-reference on-chain signals with price action -- divergences are the most valuable signals.
- Specify which blockchain/chain the data comes from. On-chain metrics vary by chain.

## Risk Disclosures

- On-chain metrics are descriptive, not predictive. They indicate network state but do not guarantee price direction.
- DeFi protocols carry smart contract risk regardless of audit status. Audits reduce but do not eliminate risk.
- Whale tracking data may have a delay. Large holders often use multiple wallets and OTC desks, making tracking imperfect.
- Yield farming involves smart contract risk, impermanent loss risk, and protocol governance risk. APYs can change rapidly.
- Token unlock schedules may change. Always verify against official project documentation.
