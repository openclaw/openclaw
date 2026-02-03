# Liquidity Games

Game theory of AMMs, liquidity provision, and market making.

## The Liquidity Provider's Dilemma

LPs face a fundamental trade-off:
- **Earn fees** from trading volume
- **Lose to arbitrageurs** via adverse selection

The game is: Are fees enough to compensate for losses to informed traders?

## Players in AMM Games

### Liquidity Providers (LPs)
- Deposit assets into pools
- Earn trading fees
- Suffer impermanent loss

### Noise Traders
- Trade for non-informational reasons
- Pay fees
- LPs profit from these trades

### Arbitrageurs
- Trade to align AMM price with external price
- Extract value from LPs
- Zero-sum with LPs

### MEV Searchers
- Sandwich attacks
- JIT liquidity
- Extract from both traders and LPs

## Impermanent Loss Deep Dive

### What It Is

IL is the cost of providing liquidity vs. holding.

**Formula (constant product x*y=k):**
```
IL = 2 * sqrt(price_ratio) / (1 + price_ratio) - 1

Where price_ratio = new_price / initial_price
```

### Why It Happens

**The adverse selection explanation:**
1. External price moves (e.g., up)
2. Arbitrageur buys cheap tokens from AMM
3. LP sells at stale price
4. LP would have been better off holding

**Game theory framing:** LPs are market makers who are always on the wrong side of informed trades.

### IL vs. Price Change

| Price Change | Impermanent Loss |
|--------------|------------------|
| 1.25x (25% up) | 0.6% |
| 1.50x (50% up) | 2.0% |
| 2x (100% up) | 5.7% |
| 3x (200% up) | 13.4% |
| 5x (400% up) | 25.5% |

**Key insight:** IL is convex in price change. Large moves hurt disproportionately.

### When LPs Profit

**Condition for LP profitability:**
```
Fees earned > Impermanent loss + opportunity cost
```

**Factors favoring LPs:**
- High trading volume
- Low volatility
- Mean-reverting prices
- High fee tiers

**Factors hurting LPs:**
- Low volume, high volatility
- Trending prices
- Low fees
- Informed/toxic flow

## Concentrated Liquidity Games

### The Uniswap V3 Revolution

**Old model (V2):** Liquidity spread across all prices
**New model (V3):** LPs choose price ranges

### Game Theory Implications

**Benefits:**
- Higher capital efficiency
- Better prices for traders in-range
- More fee income per dollar deposited

**Costs:**
- Active management required
- Out-of-range = no fees + full price exposure
- Greater IL within range

### The Concentration Game

**Players:** Multiple LPs choosing ranges

**Strategies:** 
- Wide range: Less fees per unit, but always earning
- Narrow range: More fees per unit, but may go out of range

**Equilibrium:**
- Liquidity concentrates around current price
- Competition drives down LP returns
- Arms race in rebalancing speed

### JIT Liquidity Attack

**Mechanism:**
1. See large incoming trade in mempool
2. Add concentrated liquidity at execution price
3. Capture most of the fees
4. Remove liquidity immediately

**Game theory:**
- JIT LPs have information advantage
- Passive LPs get adversely selected
- Requires MEV infrastructure

**Equilibrium effect:** 
- Passive LP returns decrease
- Liquidity becomes more dynamic
- Concentration increases at cost of stability

## Liquidity Mining Games

### The Basic Game

Protocol offers token rewards for providing liquidity.

**Players:**
- Protocol (wants liquidity)
- LPs (want yield)
- Token holders (pay for rewards via dilution)

### Farm and Dump

**Strategy:**
1. Deposit when rewards start
2. Harvest rewards
3. Sell rewards immediately
4. Leave when rewards decrease

**Game theory:**
- Rational for short-term players
- Creates sell pressure on reward token
- Liquidity leaves when rewards stop

**Protocol response:**
- Lock-up periods
- Vesting rewards
- Reward loyal LPs more

### The Sybil Problem

**Airdrop farming:**
1. Create many wallets
2. Provide minimum liquidity across all
3. Claim airdrops/rewards on each

**Game theory:**
- Protocol can't distinguish real users from Sybils
- Legitimate users get diluted
- Arms race between protocols and farmers

### Vampire Attacks

**Mechanism:**
1. Fork existing protocol
2. Offer higher rewards to migrate liquidity
3. Drain competitor's liquidity

**Classic example:** SushiSwap vs. Uniswap

**Game theory:**
- Easy to fork contracts
- Moat is liquidity, which is mobile
- Rewards/brand/network effects matter

## LP Strategy Framework

### Step 1: Assess the Pool

**Questions:**
- What's the volume/TVL ratio?
- What's the fee tier?
- How volatile is the pair?
- Who's trading (noise or informed)?
- What's the reward APR (if any)?

**Red flags:**
- Low volume, high TVL (over-supplied)
- One asset has upcoming catalyst (IL risk)
- New pool (manipulation risk)
- Extreme reward APY (unsustainable)

### Step 2: Choose Range (if concentrated)

**Considerations:**
- Current price + expected range
- Volatility (implied from options, historical)
- Rebalancing costs and capacity
- Competition from other LPs

**Heuristics:**
- Stable pairs: Tight range (e.g., 0.99-1.01)
- Correlated pairs: Medium range (e.g., 0.8-1.25x)
- Volatile pairs: Wide range or avoid

### Step 3: Monitor and Adjust

**Triggers for adjustment:**
- Price approaching range boundary
- Significant volatility change
- Fee tier changes
- Reward rate changes

**Rebalancing costs:**
- Gas fees
- Potential IL crystallization
- Opportunity cost

### Step 4: Exit Strategy

**When to exit:**
- Achieved target return
- Fundamentals changed
- Better opportunities elsewhere
- Reward program ending

## Advanced LP Strategies

### Delta Hedging

**Concept:** Offset IL with derivatives position.

**Implementation:**
- LP position = short gamma
- Buy options to hedge
- Can convert LP to pure fee income

**Game theory:**
- Requires efficient options market
- Hedging cost vs. IL reduction
- Professional market-making approach

### LP Aggregators

**Concept:** Automated rebalancing across ranges.

**Examples:** Arrakis, Gamma, etc.

**Game theory:**
- Pooled capital = better efficiency
- Algorithmic management
- Principal-agent: Is manager aligned?

### Multi-Pool Strategies

**Concept:** Spread liquidity across pools/chains.

**Considerations:**
- Correlation between pools
- Gas/bridging costs
- Yield farming synergies

## Protocol Design for Liquidity

### Fee Structure

**Trade-off:**
- Higher fees = more LP income, worse prices for traders
- Lower fees = less LP income, better prices, more volume

**Typical tiers:**
- Stable: 0.01-0.05%
- Correlated: 0.05-0.30%
- Volatile: 0.30-1.00%

### LP Protection Mechanisms

**Fee switches:**
- Protocol can turn on fee share
- Changes LP economics post-launch

**MEV protection:**
- Private mempools for LPs
- Anti-JIT mechanisms

**Insurance:**
- IL insurance products
- Protocol-subsidized coverage

### Liquidity Bootstrapping

**Problems:**
- New pools need initial liquidity
- Chicken-and-egg: No volume without liquidity, no LPs without volume

**Solutions:**
- Protocol-owned liquidity
- Liquidity mining (temporary)
- Bonds (Olympus-style)
- Bribes for liquidity

## Equilibrium Analysis

### Long-Run LP Returns

In efficient markets:
```
Expected LP return ≈ Risk-free rate + Risk premium - Adverse selection cost

Where:
- Risk premium = compensation for IL volatility
- Adverse selection = losses to informed traders
```

**Empirical finding:** Many LP positions have negative risk-adjusted returns after accounting for IL.

### Why Do LPs Persist?

1. **Reward mining:** Token rewards exceed losses
2. **Misconception:** Don't understand IL
3. **Hedging:** LP position hedges existing exposure
4. **Platform play:** Provide liquidity to own protocol
5. **Learning:** Paying for market-making education

### Market Efficiency

As LP markets mature:
- IL becomes better understood
- Sophisticated LPs dominate
- Retail LP returns compress
- Protocol must pay more for liquidity
