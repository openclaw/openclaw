# Tokenomics Analysis

Game-theoretic evaluation of token economic systems.

## The Tokenomics Game

Every token creates a game between:
- **Protocol** (wants growth, sustainability, decentralization)
- **Team** (wants compensation, control, success)
- **Investors** (want returns)
- **Users** (want utility, fair prices)
- **Speculators** (want volatility, momentum)

The tokenomics design determines how these interests align or conflict.

## Analysis Framework

### Supply Dynamics

**Questions to ask:**
1. What is the total supply? Fixed or variable?
2. What is the emission schedule?
3. What are the sink mechanisms (burns, locks)?
4. What is the terminal state?

**Red flags:**
- Unlimited inflation with no sinks
- Team can mint arbitrary amounts
- No clear path to sustainability

**Game theory:**
- Inflationary tokens: Constant selling pressure from recipients
- Deflationary tokens: Incentive to hold, may reduce liquidity
- Elastic supply: Complex dynamics, often unstable

### Distribution

**Questions to ask:**
1. Who received tokens at genesis?
2. What are the vesting schedules?
3. How concentrated is ownership?
4. Can insiders sell before others?

**Red flags:**
- >50% to team/investors
- Team fully liquid before users
- Hidden allocations
- Asymmetric vesting (insiders unlock faster)

**Game theory:**
- Early token concentration = principal-agent problem
- Long vesting aligns incentives but reduces team flexibility
- Airdrop gaming is a repeated game (Sybils learn)

### Utility and Value Accrual

**Questions to ask:**
1. What can you do with the token?
2. How does protocol revenue flow to token?
3. Is demand structural or speculative?
4. What's the relationship between usage and token value?

**Token utility types:**

| Type | Mechanism | Value Accrual |
|------|-----------|---------------|
| Governance | Voting rights | Indirect (protocol value) |
| Fee discount | Reduced costs when holding | Direct but limited |
| Staking yield | Earn more tokens | Circular (often inflationary) |
| Fee sharing | Portion of revenue | Direct |
| Buyback/burn | Protocol buys and burns | Deflationary pressure |
| Collateral | Required to participate | Direct demand |
| Access | Required for features | Direct demand |

**Game theory:**
- Pure governance tokens have weak value accrual
- Fee sharing aligns holders with protocol growth
- Inflationary staking yields are zero-sum redistribution

### Staking Mechanics

**Questions to ask:**
1. What's the staking APY? Source of yield?
2. What are lock-up periods?
3. What are slashing conditions?
4. Is there delegation?

**Analysis points:**

**APY sustainability:**
```
If APY comes from inflation: Zero-sum redistribution
If APY comes from fees: Sustainable if fees > costs
If APY comes from new users: Ponzi dynamics
```

**Lock-up game theory:**
- Longer locks = more aligned holders
- But also more illiquidity risk
- Optimal: Graduated unlocks with incentives

**Slashing design:**
- Too harsh: Discourages participation
- Too lenient: Doesn't deter misbehavior
- Needs: Clear conditions, fair implementation

### Incentive Alignment

**Check alignment between:**

| Stakeholder | Wants | Potential Misalignment |
|-------------|-------|------------------------|
| Users | Low fees, good UX | May conflict with token value |
| Holders | Price appreciation | May want monopoly pricing |
| Team | Compensation, control | May extract value |
| LPs | Fee income | May impermanent loss |
| Validators | Rewards | May censor, extract MEV |

**Aligned tokenomics:**
- Team vesting tied to metrics
- Fee sharing proportional to contribution  
- Governance power distributed
- Clear path to decentralization

## Common Patterns

### Pattern 1: Inflationary Staking

**Design:** Stake tokens, earn more tokens from inflation.

**Game theory:**
- Non-stakers diluted
- Creates pressure to stake
- Real yield = 0 if everyone stakes
- Actually a tax on non-stakers

**When it works:**
- Bootstrapping phase
- Combined with fee sharing
- Clear end to inflation

**When it fails:**
- Perpetual high inflation
- Whales accumulate, retail diluted
- No utility beyond staking

### Pattern 2: Revenue Sharing

**Design:** Protocol revenue distributed to token holders/stakers.

**Game theory:**
- Aligns holders with protocol growth
- Creates fundamental value floor
- Dividend discount model applies

**When it works:**
- Protocol has real revenue
- Distribution is fair (not captured by insiders)
- Revenue growing

**When it fails:**
- Revenue is minimal
- Complex distribution favoring insiders
- Revenue not sustainable

### Pattern 3: Buyback and Burn

**Design:** Protocol uses revenue to buy and burn tokens.

**Game theory:**
- Reduces supply = increases price (all else equal)
- Benefits all holders proportionally
- Avoids taxable distribution

**When it works:**
- Consistent revenue
- Transparent execution
- Not front-runnable

**When it fails:**
- Sporadic or manipulated buybacks
- Insiders sell into buybacks
- Price impact negligible relative to supply

### Pattern 4: Vote Escrow (ve)

**Design:** Lock tokens for voting power and rewards. Longer lock = more power.

**Game theory:**
- Rewards long-term holders
- Reduces liquid supply (price support)
- Creates bribing market (Votium, Hidden Hand)

**When it works:**
- Meaningful governance decisions
- Bribe income attractive
- Lock periods reasonable

**When it fails:**
- Governance captured anyway
- Bribes extracted by whales
- Lock too long, becomes illiquid

### Pattern 5: Dual Token

**Design:** Separate governance/staking token from utility/gas token.

**Game theory:**
- Can optimize each for purpose
- Complexity for users
- Value accrual may be unclear

**When it works:**
- Clear utility for each token
- Fair distribution of both
- Value flows between them logically

**When it fails:**
- One token becomes worthless
- Arbitrage between tokens complex
- Users confused

## Quantitative Analysis

### Token Value Model

Simplified discounted cash flow:

```
Value = Sum of (Future Revenue to Token / (1 + r)^t)
```

Where r = discount rate reflecting risk.

**For fee-sharing tokens:**
```
P/E Ratio = Price / (Annual Fees to Token)
Compare to similar protocols
```

**For governance tokens:**
```
Value = Expected value of governance control
      + Expected value of future utility
      + Speculation premium
```

### Emission Analysis

**Calculate:**
```
Current circulating supply: C
Total supply: T
Annual emission: E
Fully diluted valuation: FDV = Price * T
Market cap: MC = Price * C

Key ratios:
- MC/FDV = C/T (how much is unlocked)
- Inflation rate = E/C (annual dilution)
```

**Warning signs:**
- MC/FDV < 0.3 (most supply locked, will unlock)
- Inflation > 20% (heavy dilution)
- Emission to insiders > emission to users

### Holder Analysis

**On-chain metrics:**
```
- Gini coefficient of holdings (concentration)
- % held by top 10/100 addresses
- Exchange inflows/outflows
- Staking ratio (locked vs liquid)
```

**Game theory interpretation:**
- High concentration = whale manipulation risk
- Exchange inflows = selling pressure incoming
- Low staking = weak holder conviction

## Case Study Template

```markdown
## [Protocol Name] Tokenomics Analysis

### Overview
- Token: [Symbol]
- Current Price: $X
- Market Cap: $Y
- FDV: $Z

### Supply Analysis
- Total supply: X
- Circulating: Y (Z%)
- Emission schedule: [description]
- Sinks: [burns, locks, etc.]

### Distribution
| Allocation | % | Vesting |
|------------|---|---------|
| Team | X% | Y months |
| Investors | X% | Y months |
| Community | X% | [details] |

### Utility Analysis
- Primary use: [governance/staking/fee/etc.]
- Value accrual: [mechanism]
- Demand drivers: [what creates demand]

### Game Theory Assessment
- Incentive alignment: [Strong/Moderate/Weak]
- Key tensions: [list conflicts]
- Attack vectors: [governance capture, dilution, etc.]

### Verdict
[Sustainable/Concerning/Ponzi]
[Key recommendations]
```

## Red Flag Checklist

| Red Flag | Why It's Bad |
|----------|--------------|
| Anonymous team with unlocked tokens | Can rug |
| Emissions >> Revenue | Unsustainable |
| Team can mint unlimited | Inflation risk |
| Governance can change tokenomics | Rug via governance |
| No vesting for insiders | Dump risk |
| Utility is only "governance" | Weak value accrual |
| Staking yield > 100% APY | Ponzi math |
| FDV >> MC (>5x) | Massive unlocks coming |
| Complex tokenomics | Hiding something |
| Rewards for recruiting | Ponzi structure |
