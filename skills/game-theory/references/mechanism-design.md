# Mechanism Design

The art of designing games to achieve desired outcomes. "Reverse game theory."

> "If game theory asks 'what will happen?', mechanism design asks 'what rules create the outcome we want?'"

## The Mechanism Design Problem

Given:
- A set of possible outcomes
- Agents with private information (types)
- A social choice function (desired mapping from types to outcomes)

Design:
- A game (mechanism) where equilibrium play implements the social choice function

## Key Concepts

### Incentive Compatibility

A mechanism is incentive compatible if truthful revelation is optimal.

**Dominant Strategy Incentive Compatible (DSIC):**
Truth-telling is dominant regardless of others' strategies.

**Bayesian Incentive Compatible (BIC):**
Truth-telling is optimal given beliefs about others.

**DSIC is stronger:** Works even against colluding opponents.

**Crypto relevance:** Oracle mechanisms need DSIC - reporters shouldn't benefit from lying regardless of what others report.

### Individual Rationality

Participation must be voluntary and beneficial. Agents must prefer participating to not participating.

**Ex-ante IR:** Expected utility from participation is non-negative.
**Interim IR:** Utility is non-negative for each type.
**Ex-post IR:** Utility is non-negative for each outcome.

**Crypto relevance:** Staking mechanisms must offer IR - expected rewards must exceed opportunity cost.

### The Revelation Principle

For any mechanism with an equilibrium achieving outcome X, there exists a direct mechanism where:
1. Agents report their types directly
2. Truth-telling is an equilibrium
3. The same outcome X is achieved

**Implication:** When designing mechanisms, we can focus on direct, truth-telling mechanisms without loss of generality.

**Crypto caveat:** On-chain, "direct revelation" may leak information. Privacy concerns complicate this.

## Classic Mechanisms

### Vickrey-Clarke-Groves (VCG)

The canonical DSIC mechanism for efficient allocation.

**How it works:**
1. Agents report valuations
2. Mechanism chooses efficient allocation (maximizes total reported value)
3. Each agent pays the externality they impose on others

**Properties:**
- DSIC: Truth-telling is dominant
- Efficient: Maximizes total welfare
- Not budget-balanced: May run deficit or surplus

**Crypto applications:**
- MEV auctions (sort of)
- Resource allocation in blockchains
- Fair ordering mechanisms

**Limitations:**
- Vulnerable to collusion
- Requires quasi-linear utility
- Payments can be large

### Second-Price (Vickrey) Auction

Special case of VCG for single-item auctions.

**Rules:**
1. Sealed bids
2. Highest bidder wins
3. Pays second-highest bid

**Why DSIC:** 
- Bidding above value: Risk paying more than value
- Bidding below value: Risk losing when you'd profit
- Bidding exactly value: Dominant

**Crypto applications:**
- NFT auctions
- Block space allocation (in theory)
- Name registration

### First-Price Auction

Not DSIC, but commonly used.

**Rules:**
1. Sealed bids
2. Highest bidder wins
3. Pays own bid

**Equilibrium:** Bid below value, amount depends on competitors.

**Why used despite not being DSIC:**
- Revenue may be higher
- Simpler to explain
- No need to reveal second price

**Crypto applications:**
- Most actual NFT auctions
- Gas price auctions (essentially)

### English Auction (Ascending)

Open ascending price auction.

**Properties:**
- Strategically equivalent to second-price
- More transparent
- Creates excitement/engagement

**Crypto applications:**
- Some NFT platforms
- Slow but engaging for high-value items

### Dutch Auction (Descending)

Price starts high, decreases until someone buys.

**Properties:**
- Strategically equivalent to first-price
- Fast resolution
- Good for multiple identical items

**Crypto applications:**
- Fair launches (Paradigm's approach)
- Token sales
- Reduces gas wars

## Impossibility Results

### Myerson-Satterthwaite

For bilateral trade with private values, no mechanism is simultaneously:
- DSIC
- Individually rational
- Budget-balanced
- Efficient

**Crypto implication:** Perfect decentralized exchanges are impossible. Some efficiency loss is inevitable.

### Gibbard-Satterthwaite

Any voting mechanism that is:
- Defined for all preference profiles
- Produces a single winner
- Non-dictatorial

Must be manipulable (not strategy-proof).

**Crypto implication:** Perfect governance mechanisms don't exist. All voting systems can be gamed.

### Arrow's Impossibility

No social welfare function satisfies:
- Unrestricted domain
- Pareto efficiency
- Independence of irrelevant alternatives
- Non-dictatorship

**Crypto implication:** Aggregating community preferences is fundamentally hard.

## Mechanism Design in Crypto

### Oracle Mechanism Design

**Problem:** Get truthful off-chain data on-chain.

**Approaches:**

**Schelling Point Mechanisms:**
- Reporters coordinate on truth as focal point
- Penalties for deviation from consensus
- Example: Chainlink, UMA

**Skin in the Game:**
- Stake tokens, lose stake for wrong reports
- Requires defining "wrong"
- Example: Augur, Kleros

**Commit-Reveal:**
- Commit hash of answer, then reveal
- Prevents copying
- Adds delay

**Design considerations:**
- Cost of corruption must exceed value of manipulation
- Attacker may be the one asking the question
- Recursive incentive problems

### MEV Mechanism Design

**Problem:** Transaction ordering creates extractable value.

**Approaches:**

**Fair Ordering:**
- First-come-first-served (hard on decentralized networks)
- Random ordering (adds latency)
- Threshold encryption (complex)

**MEV Auctions:**
- Flashbots-style: Bundle auctions
- PBS (Proposer-Builder Separation)
- MEV smoothing across validators

**MEV Sharing:**
- Return MEV to users (MEV Blocker)
- Protocol-captured MEV (Osmosis)

**The fundamental tradeoff:** Fairness vs. efficiency vs. complexity.

### Governance Mechanism Design

**Problem:** Make collective decisions without capture.

**Approaches:**

**Token Voting:**
- Simple but plutocratic
- Vulnerable to flash loans
- Rational apathy problem

**Quadratic Voting:**
- Vote weight = sqrt(tokens)
- Reduces plutocracy
- Sybil vulnerable

**Conviction Voting:**
- Votes accumulate over time
- Rewards long-term holders
- Complex dynamics

**Futarchy:**
- Vote on values, bet on beliefs
- Prediction markets for policy
- Experimental

**Optimistic Governance:**
- Proposals pass unless challenged
- Reduces voter burden
- Requires monitoring

### Tokenomics as Mechanism Design

**Goal:** Align incentives of all stakeholders.

**Emission schedules:**
- Front-loaded: Bootstrapping, but sell pressure
- Back-loaded: Sustainable, but slow adoption
- Algorithmic: Responsive, but complex

**Staking mechanics:**
- Lock-up periods: Align time horizons
- Slashing: Penalize misbehavior
- Delegation: Enable participation

**Fee distribution:**
- To token holders: Aligns with growth
- To LPs: Sustains liquidity
- Burned: Deflationary pressure

## Advanced Topics

### Collusion Resistance

VCG and many mechanisms fail against collusion.

**Approaches:**
- Cryptographic methods (commit-reveal, ZK)
- Costly collusion (require side payments)
- Detection and punishment
- Limiting coalitional gains

### Sybil Resistance

One person, multiple identities breaks many mechanisms.

**Approaches:**
- Proof of personhood (Worldcoin, Gitcoin Passport)
- Stake-weighted (plutocratic but Sybil-resistant)
- Social graph analysis
- Costly identity creation

### Dynamic Mechanism Design

Mechanisms that work over time.

**Challenges:**
- Commitment problems
- Renegotiation
- Learning and adaptation
- Reputation effects

### Computational Mechanism Design

Mechanisms must be computationally feasible.

**Constraints:**
- On-chain computation is expensive
- Complex mechanisms may not be implementable
- Gas costs affect participation
- Verification must be cheap

## Design Checklist

When designing a mechanism:

1. **Define the goal precisely**
   - What outcome do you want?
   - Whose welfare matters?

2. **Identify private information**
   - What do agents know that you don't?
   - What can they lie about?

3. **Check incentive compatibility**
   - Is truth-telling optimal?
   - What are the gains from lying?

4. **Verify individual rationality**
   - Will agents participate?
   - Is the outside option properly modeled?

5. **Consider collusion**
   - Can agents coordinate to game the mechanism?
   - What coalitions are realistic?

6. **Assess Sybil vulnerability**
   - Can creating multiple identities help?
   - How is identity established?

7. **Evaluate computational feasibility**
   - Can this run on-chain?
   - What's the gas cost?

8. **Test with adversarial thinking**
   - How would you exploit this mechanism?
   - What's the worst-case outcome?
