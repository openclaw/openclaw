# Nash Equilibrium

A strategy profile where no player can improve their payoff by unilaterally changing their strategy.

## Formal Definition

A Nash equilibrium is a set of strategies (s1*, s2*, ..., sn*) such that for each player i:

```
ui(si*, s-i*) >= ui(si, s-i*) for all si in Si
```

Where:
- ui is player i's payoff function
- si* is player i's equilibrium strategy
- s-i* is the equilibrium strategies of all other players
- Si is player i's strategy set

## Types of Nash Equilibrium

### Pure Strategy Nash Equilibrium
Each player chooses a single deterministic action.

**Example:** In a coordination game where both players benefit from choosing the same option, both choosing A or both choosing B are pure strategy equilibria.

### Mixed Strategy Nash Equilibrium
Players randomize over actions with specific probabilities.

**Example:** In matching pennies, each player randomizes 50/50 between heads and tails.

**Crypto relevance:** MEV searchers often use mixed strategies to avoid predictability.

### Symmetric Nash Equilibrium
All players use the same strategy.

**Crypto relevance:** In many DeFi games, symmetric equilibria are focal points.

## Finding Nash Equilibria

### Method 1: Best Response Analysis

1. For each player, find best response to every possible opponent strategy
2. Nash equilibrium exists where best responses intersect

**Example (2x2 game):**
```
                Player 2
              L       R
Player 1  U  (3,3)   (0,5)
          D  (5,0)   (1,1)
```

- If P2 plays L: P1's best response is D (5 > 3)
- If P2 plays R: P1's best response is D (1 > 0)
- If P1 plays U: P2's best response is R (5 > 3)
- If P1 plays D: P2's best response is L (0 > 1)

Nash equilibrium: (D, L) with payoffs (5, 0)? No - P2 would deviate.
Need to check: at (D,L), P2 gets 0, could get 1 at (D,R). Deviates.
At (D,R), P1 gets 1, could get 5 at (D,L). Check P2: gets 1, could get 0 at (D,L). No deviation.
(D,R) is Nash equilibrium with payoffs (1,1).

### Method 2: Iterated Elimination of Dominated Strategies

Remove strategies that are never best responses, iterate until stable.

### Method 3: Support Enumeration (for mixed equilibria)

For each possible support (set of strategies played with positive probability), solve for probabilities that make opponent indifferent.

## Properties

### Existence
Every finite game has at least one Nash equilibrium (possibly mixed).

### Uniqueness
Not guaranteed. Many games have multiple equilibria.

### Efficiency
Nash equilibria may not be Pareto efficient (see: Prisoner's Dilemma).

### Stability
Players have no incentive to deviate unilaterally, but:
- Coalition deviations may be profitable
- Trembling (small mistakes) may destabilize

## Refinements

### Subgame Perfect Equilibrium
Nash equilibrium in every subgame. Rules out non-credible threats.

**Crypto relevance:** Evaluating whether protocol threats (slashing) are credible.

### Trembling Hand Perfect Equilibrium
Equilibrium survives if players make small mistakes with tiny probability.

**Crypto relevance:** Robust mechanism design that works despite user errors.

### Sequential Equilibrium
For games with imperfect information. Combines strategies and beliefs.

**Crypto relevance:** Trading games where participants have private information.

## Crypto Applications

### Validator Economics

**Game:** Validators choose how much to stake.

**Players:** n validators
**Strategies:** Stake amount si >= 0
**Payoffs:** Rewards proportional to stake share, minus opportunity cost

**Equilibrium:** Staking continues until marginal reward equals opportunity cost for all validators.

**Analysis questions:**
- Is the security budget sufficient?
- Can cartels form to extract more value?
- What happens if a large player exits?

### AMM Liquidity Provision

**Game:** LPs choose where to provide liquidity.

**Players:** Liquidity providers
**Strategies:** Amount and price range for liquidity
**Payoffs:** Fees earned minus impermanent loss

**Equilibrium:** Liquidity distributed such that marginal return equals across positions.

**Insight:** Concentrated liquidity shifts equilibrium toward more competition at active prices.

### Gas Price Bidding

**Game:** Users compete for block inclusion.

**Players:** Transaction senders
**Strategies:** Gas price bid
**Payoffs:** Value of inclusion minus gas cost

**Equilibrium:** Bids rise until marginal bidder is indifferent between inclusion and waiting.

**Pathology:** During congestion, equilibrium can involve extreme overbidding.

### Governance Voting

**Game:** Token holders vote on proposals.

**Players:** Token holders with varying stakes
**Strategies:** Vote yes, no, or abstain
**Payoffs:** Depend on proposal outcome and voting costs

**Equilibrium:** Often rational apathy - small holders don't vote because impact is negligible.

**Attack:** Voter apathy allows concentrated interests to capture governance.

## Limitations

### Rationality Assumption
Nash equilibrium assumes perfect rationality. Real actors:
- Have bounded rationality
- Make mistakes
- Have incomplete information about payoffs

### Equilibrium Selection
With multiple equilibria, theory doesn't predict which will occur.

### Computational Complexity
Finding Nash equilibria is PPAD-complete (computationally hard).

### Dynamic Considerations
Static Nash analysis misses:
- Learning dynamics
- Reputation effects
- Time preferences

## Best Practices for Analysis

1. **Start simple:** Model the core interaction first, add complexity later.

2. **Identify all players:** Including passive ones (e.g., retail in MEV games).

3. **Be precise about payoffs:** Vague payoffs lead to vague conclusions.

4. **Check for multiple equilibria:** Don't assume uniqueness.

5. **Stress test equilibrium:** What breaks it? Collusion? New entrants? Parameter changes?

6. **Consider dynamics:** Is the equilibrium reachable? Stable to perturbations?
