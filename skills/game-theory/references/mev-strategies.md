# MEV Game Theory

Maximal Extractable Value: the game of transaction ordering.

> "In the beginning there was the mempool. And the mempool was dark and full of terrors."

## What is MEV?

Value that can be extracted by reordering, inserting, or censoring transactions within a block.

**Players:**
- Users (transaction senders)
- Searchers (MEV extractors)
- Builders (block constructors)
- Proposers/Validators (block producers)

**The fundamental insight:** On a blockchain, order matters. Whoever controls order controls value.

## MEV Taxonomy

### Arbitrage

Exploiting price differences across venues.

**Example:**
1. Token X is $100 on Uniswap, $102 on Sushiswap
2. Searcher buys on Uniswap, sells on Sushiswap
3. Profit: $2 minus gas

**Game theory:**
- Competition drives profits toward zero
- Winner is fastest/most gas-efficient
- Validators extract via priority fees
- Generally considered "benign" MEV

**Equilibrium:** Arbitrage profits = cost of extraction (gas + priority fees)

### Sandwich Attacks

Front-running and back-running a victim's trade.

**Mechanism:**
1. Victim submits large swap (buy token X)
2. Attacker front-runs: buys X, raising price
3. Victim's trade executes at worse price
4. Attacker back-runs: sells X at inflated price

**Game theory:**
- Attacker profits from victim's price impact
- Victim always loses (gets worse execution)
- Arms race in speed and gas bidding
- Clearly extractive/harmful

**Victim's defenses:**
- Lower slippage tolerance (may fail to execute)
- Private mempools (Flashbots Protect, MEV Blocker)
- DEX aggregators with MEV protection
- Smaller trades
- Limit orders instead of market orders

### Liquidations

Racing to liquidate undercollateralized positions.

**Mechanism:**
1. Position becomes liquidatable
2. Multiple searchers race to call liquidate()
3. Winner receives liquidation bonus

**Game theory:**
- Pure speed competition
- Priority gas auctions (PGAs)
- Often benefits protocol (faster liquidations = more stability)
- Can cascade in volatile markets

**Design considerations:**
- Higher bonuses = faster liquidation but more MEV
- Dutch auction liquidations reduce racing
- Keeper networks coordinate to reduce waste

### JIT (Just-In-Time) Liquidity

Providing liquidity only for specific trades.

**Mechanism:**
1. Large swap detected in mempool
2. LP adds concentrated liquidity at execution price
3. Captures fees from the swap
4. Removes liquidity immediately after

**Game theory:**
- Competes with passive LPs
- Requires precise timing
- Only profitable for large swaps
- Controversial: efficient or extractive?

### NFT Sniping

Front-running NFT purchases.

**Mechanism:**
1. Valuable NFT listed below floor
2. Multiple bots race to purchase
3. Winner gets underpriced NFT

**Game theory:**
- Similar to arbitrage
- Speed + gas optimization
- Marketplaces try to prevent (rate limits, private listings)

### Long-Tail MEV

Protocol-specific extraction opportunities.

**Examples:**
- Governance proposal sniping
- Airdrop claim racing
- Oracle update front-running
- Cross-chain arbitrage

## The MEV Supply Chain

### Pre-PBS (Proposer-Builder Separation)

```
Users -> Mempool -> Searchers -> Miners/Validators
```

- Validators had all the power
- Could extract directly or accept bribes
- Limited competition

### Post-PBS

```
Users -> Mempool -> Searchers -> Builders -> Relays -> Proposers
```

**Searchers:**
- Find MEV opportunities
- Create transaction bundles
- Compete by bidding to builders

**Builders:**
- Aggregate bundles into blocks
- Optimize for total extractable value
- Bid to proposers for block space

**Relays:**
- Trusted intermediaries
- Prevent builder-proposer collusion
- Verify block validity before revealing

**Proposers:**
- Select highest-bidding valid block
- Don't need to understand MEV
- Commoditized role

### Game Theoretic Analysis

**Searcher competition:**
- Drives profits toward zero
- Specialization emerges (arb vs. liquidation vs. sandwich)
- Information asymmetry creates edge

**Builder competition:**
- Network effects (more searchers -> better blocks -> more proposers)
- Centralization pressure (few dominant builders)
- Censorship concerns (builders can exclude)

**Proposer-builder relationship:**
- Proposers want maximum bids
- Builders want maximum margin
- Relays mediate trust

## MEV Mitigation Strategies

### For Users

**Private transaction submission:**
- Flashbots Protect
- MEV Blocker
- BloxRoute
- Direct to builder

**Slippage management:**
- Tight slippage (may fail)
- Wide slippage (vulnerable)
- Optimal: estimate price impact + buffer

**Trade splitting:**
- Multiple smaller trades
- Reduces individual price impact
- Higher total gas cost

**Limit orders:**
- No slippage vulnerability
- May not execute
- Requires on-chain order book or keeper network

### For Protocols

**Fair ordering:**
- First-come-first-served (hard to implement fairly)
- Commit-reveal (adds latency)
- Threshold encryption (complex)
- Verifiable delay functions

**Batch auctions:**
- Collect orders over time
- Execute at single clearing price
- Eliminates front-running within batch
- Example: CoW Protocol

**MEV sharing:**
- Return extracted MEV to users/LPs
- Requires measuring MEV (hard)
- Example: MEV-Share, OEV

**Application-specific solutions:**
- Oracle Extractable Value (OEV) auctions
- AMM designs that minimize MEV
- Intent-based trading

### For the Network

**Encrypted mempools:**
- Transactions encrypted until ordering committed
- Eliminates information advantage
- Complexity and latency costs
- Example: Shutter Network

**MEV burn:**
- Redirect MEV to protocol/burn
- Reduces incentive for extraction
- Implementation challenges

**Decentralized builders:**
- Reduce centralization risk
- Maintain censorship resistance
- Active research area

## Game Theory Models

### Priority Gas Auction (PGA)

**Model:**
- N searchers competing for one opportunity
- Opportunity worth V
- Searchers bid gas prices
- Highest bid wins, pays their bid

**Equilibrium:**
- All-pay auction dynamics
- Winner's curse
- Profits driven to near zero
- Losers waste gas

**Inefficiency:**
- Failed transactions consume resources
- Network congestion
- Value flows to validators, not users

### Builder Game

**Model:**
- Builders receive bundles from searchers
- Build blocks to maximize total value
- Bid to proposers for inclusion

**Equilibrium:**
- Competitive builders bid away profits
- Marginal builder earns zero
- Inframarginal builders earn rents (efficiency advantages)

**Centralization pressure:**
- More volume -> better optimization -> more volume
- Natural monopoly tendencies
- Mitigated by credible neutrality requirements

### Multi-Block MEV

**Model:**
- Proposers control multiple consecutive blocks
- More ordering flexibility = more MEV
- Creates incentive to acquire multiple slots

**Equilibrium:**
- Validators may buy/bribe for consecutive slots
- Concentrated validator power
- "Time bandit" attacks possible

**Mitigations:**
- Single slot finality
- Proposer diversity requirements
- MEV smoothing

## Empirical Patterns

### MEV by Type (Ethereum)

Approximate breakdown (varies over time):
- Arbitrage: ~60%
- Sandwich: ~20%
- Liquidations: ~15%
- Other: ~5%

### MEV Trends

1. **Growing absolute value** - More DeFi activity = more MEV
2. **Compressing margins** - Competition drives down per-unit profit
3. **Increasing sophistication** - Cross-domain, cross-chain, multi-block
4. **Infrastructure maturation** - PBS, MEV-Share, OEV auctions

### Who Captures MEV?

Pre-PBS: Mostly miners/validators
Post-PBS: 
- ~90% to proposers (via builder bids)
- ~10% to builders (margin)
- Searchers earn on information edge

## Strategic Implications

### For Protocol Designers

1. **Assume adversarial ordering** - Don't rely on tx order
2. **Minimize information leakage** - Encrypted inputs where possible
3. **Design for MEV-awareness** - Build in protections or capture
4. **Consider batch mechanisms** - Eliminate within-batch MEV

### For Users

1. **Use MEV protection** - Private mempools are free
2. **Understand your exposure** - Large trades are targets
3. **Consider timing** - Low-activity periods have less MEV competition
4. **Check execution quality** - Compare to CEX prices

### For Searchers/Builders

1. **Specialize** - Find unique edges
2. **Invest in infrastructure** - Speed and efficiency matter
3. **Consider reputation** - Long-term relationships > short-term extraction
4. **Watch for regime changes** - PBS, encrypted mempools, new chains

## The Philosophical Question

Is MEV good or bad?

**Arguments it's good:**
- Arbitrage improves price efficiency
- Liquidations maintain protocol health
- Competition drives innovation

**Arguments it's bad:**
- Sandwich attacks are pure extraction
- Centralizes infrastructure
- Degrades user experience
- Invisible tax on users

**The nuanced view:**
- Some MEV is alignment (arbitrage, liquidation)
- Some MEV is extraction (sandwich)
- Goal: Minimize extractive MEV, accept aligned MEV
- Better mechanisms can shift the balance
