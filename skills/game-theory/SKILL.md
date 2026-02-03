---
name: game-theory
description: Advanced game theory analysis for crypto protocols, DeFi mechanisms, governance systems, and strategic decision-making. Use when analyzing tokenomics, evaluating protocol incentives, predicting adversarial behavior, designing mechanisms, or understanding strategic interactions in web3.
metadata: {"clawdbot":{"emoji":"","homepage":"https://github.com/tedkaczynski-the-bot/game-theory"}}
---

# Game Theory for Crypto

Strategic analysis framework for understanding and designing incentive systems in web3.

> "Every protocol is a game. Every token is an incentive. Every user is a player. Understand the rules, or become the played."

## When to Use This Skill

- Analyzing tokenomics for exploits or misaligned incentives
- Evaluating governance proposals and voting mechanisms
- Understanding MEV and adversarial transaction ordering
- Designing auction mechanisms (NFT drops, token sales, liquidations)
- Predicting how rational actors will behave in a system
- Identifying attack vectors in DeFi protocols
- Modeling liquidity provision strategies
- Assessing protocol sustainability

## Core Framework

### The Five Questions

For any protocol or mechanism, ask:

1. **Who are the players?** (Users, LPs, validators, searchers, governance token holders)
2. **What are their strategies?** (Actions available to each player)
3. **What are the payoffs?** (How does each outcome affect each player?)
4. **What information do they have?** (Complete, incomplete, asymmetric?)
5. **What's the equilibrium?** (Where do rational actors end up?)

### Analysis Template

```markdown
## Protocol: [Name]

### Players
- Player A: [Role, objectives, constraints]
- Player B: [Role, objectives, constraints]
- ...

### Strategy Space
- Player A can: [List possible actions]
- Player B can: [List possible actions]

### Payoff Structure
- If (A does X, B does Y): A gets [payoff], B gets [payoff]
- ...

### Information Structure
- Public information: [What everyone knows]
- Private information: [What only some players know]
- Observable actions: [What can be seen on-chain]

### Equilibrium Analysis
- Nash equilibrium: [Stable outcome where no player wants to deviate]
- Dominant strategies: [Strategies that are always best regardless of others]
- Potential exploits: [Deviations that benefit attackers]

### Recommendations
- [Design changes to improve incentive alignment]
```

## Reference Documents

| Document | Use Case |
|----------|----------|
| [Nash Equilibrium](references/nash-equilibrium.md) | Finding stable outcomes in strategic interactions |
| [Mechanism Design](references/mechanism-design.md) | Designing systems with desired equilibria |
| [Auction Theory](references/auction-theory.md) | Token sales, NFT drops, liquidations |
| [MEV Game Theory](references/mev-strategies.md) | Adversarial transaction ordering |
| [Tokenomics Analysis](references/tokenomics-analysis.md) | Evaluating token incentive structures |
| [Governance Attacks](references/governance-attacks.md) | Voting manipulation and capture |
| [Liquidity Games](references/liquidity-games.md) | LP strategies and impermanent loss |
| [Information Economics](references/information-economics.md) | Asymmetric information and signaling |

## Quick Concepts

### Nash Equilibrium
A state where no player can improve their payoff by unilaterally changing strategy. The "stable" outcome of a game.

**Crypto application:** In a staking system, Nash equilibrium determines the stake distribution across validators.

### Dominant Strategy
A strategy that's optimal regardless of what others do.

**Crypto application:** In a second-price auction, bidding your true value is dominant.

### Pareto Efficiency
An outcome where no one can be made better off without making someone worse off.

**Crypto application:** AMM fee structures try to be Pareto efficient for traders and LPs.

### Mechanism Design
"Reverse game theory" - designing rules to achieve desired outcomes.

**Crypto application:** Designing token vesting schedules to align long-term incentives.

### Schelling Point
A solution people converge on without communication.

**Crypto application:** Why certain price levels act as psychological support/resistance.

### Incentive Compatibility
When truthful behavior is optimal for participants.

**Crypto application:** Oracle designs where honest reporting is the dominant strategy.

### Common Knowledge
Everyone knows X, everyone knows everyone knows X, infinitely recursive.

**Crypto application:** Public blockchain state creates common knowledge of balances/positions.

## Analysis Patterns

### Pattern 1: The Tragedy of the Commons

**Structure:** Shared resource, individual incentive to overuse, collective harm.

**Crypto examples:**
- Gas price bidding during congestion
- Governance token voting apathy
- MEV extraction degrading UX

**Solution approaches:**
- Harberger taxes
- Quadratic mechanisms
- Commitment schemes

### Pattern 2: The Prisoner's Dilemma

**Structure:** Individual rationality leads to collective irrationality.

**Crypto examples:**
- Liquidity mining mercenaries (farm and dump)
- Race-to-bottom validator fees
- Bridge security (each chain wants others to secure)

**Solution approaches:**
- Repeated games (reputation)
- Commitment mechanisms (staking/slashing)
- Mechanism redesign

### Pattern 3: The Coordination Game

**Structure:** Multiple equilibria, players want to coordinate but may fail.

**Crypto examples:**
- Which L2 to use?
- Token standard adoption
- Hard fork coordination

**Solution approaches:**
- Focal points (Schelling points)
- Sequential moves (first mover advantage)
- Communication mechanisms

### Pattern 4: The Principal-Agent Problem

**Structure:** One party acts on behalf of another with misaligned incentives.

**Crypto examples:**
- Protocol team vs token holders
- Delegates in governance
- Fund managers

**Solution approaches:**
- Incentive alignment (token vesting)
- Monitoring (transparency)
- Bonding (skin in game)

### Pattern 5: Adverse Selection

**Structure:** Information asymmetry leads to market breakdown.

**Crypto examples:**
- Token launches (team knows more than buyers)
- Insurance protocols (risky users more likely to buy)
- Lending (borrowers know their risk better)

**Solution approaches:**
- Signaling (lock-ups, audits)
- Screening (credit scores, history)
- Pooling equilibria

### Pattern 6: Moral Hazard

**Structure:** Hidden action after agreement leads to risk-taking.

**Crypto examples:**
- Protocols with insurance may take more risk
- Bailout expectations encourage leverage
- Anonymous teams may rug

**Solution approaches:**
- Monitoring and transparency
- Incentive alignment
- Reputation systems

## Common Crypto Games

### The MEV Game

**Players:** Users, searchers, builders, validators
**Key insight:** Transaction ordering is a game; users are often the losers

See: [MEV Strategies](references/mev-strategies.md)

### The Liquidity Game

**Players:** LPs, traders, arbitrageurs
**Key insight:** Impermanent loss is the cost of being adversely selected against

See: [Liquidity Games](references/liquidity-games.md)

### The Governance Game

**Players:** Token holders, delegates, protocol team
**Key insight:** Rational apathy + concentrated interests = capture

See: [Governance Attacks](references/governance-attacks.md)

### The Staking Game

**Players:** Stakers, validators, delegators
**Key insight:** Security budget must exceed attack profit

See: [Tokenomics Analysis](references/tokenomics-analysis.md)

### The Oracle Game

**Players:** Data providers, consumers, attackers
**Key insight:** Profit from manipulation must be less than cost

See: [Mechanism Design](references/mechanism-design.md)

## Red Flags in Protocol Design

### Tokenomics Red Flags
- Insiders can sell before others (vesting asymmetry)
- Inflation benefits few, dilutes many
- No sink mechanisms (perpetual selling pressure)
- Rewards without risk (free money = someone else paying)

### Governance Red Flags
- Low quorum thresholds (minority capture)
- No time delay (flash loan attacks)
- Token voting only (plutocracy)
- Delegates with no skin in game

### Mechanism Red Flags
- First-come-first-served (bot advantage)
- Sealed bids without commitment (frontrunning)
- Rebates/refunds (MEV extraction)
- Complex formulas (hidden exploits)

## Advanced Topics

### Repeated Games and Reputation
Single-shot games often have bad equilibria. Repetition enables cooperation through:
- Trigger strategies (cooperate until defection)
- Reputation building (costly to destroy)
- Future value (patient players cooperate more)

**Crypto application:** Why anonymous actors behave worse than doxxed teams.

### Evolutionary Game Theory
Strategies that survive competitive selection. Relevant for:
- Which protocols survive long-term
- Memetic competition between narratives
- Bot strategy evolution

### Bayesian Games
Games with incomplete information. Players have beliefs about others' types.

**Crypto application:** Trading with unknown counterparties, evaluating anonymous teams.

### Cooperative Game Theory
When players can form binding coalitions.

**Crypto application:** MEV extraction coalitions, validator cartels, governance blocs.

### Algorithmic Game Theory
Computational aspects of game theory.

**Crypto application:** On-chain game computation limits, gas-efficient mechanism design.

## Methodology

### Step 1: Model the Game
- Identify all players (including those not obvious)
- Map complete strategy spaces
- Define payoff functions precisely
- Specify information structure

### Step 2: Find Equilibria
- Check for dominant strategies
- Compute Nash equilibria
- Identify Pareto improvements
- Consider trembling-hand perfection

### Step 3: Stress Test
- What if players collude?
- What if new players enter?
- What if information leaks?
- What if parameters change?

### Step 4: Recommend
- Mechanism changes to improve equilibrium
- Monitoring to detect deviations
- Parameter bounds to maintain stability

## Resources

### Foundational Texts
- "Theory of Games and Economic Behavior" - von Neumann & Morgenstern
- "A Beautiful Mind" (Nash's life, accessible intro)
- "The Strategy of Conflict" - Schelling
- "Mechanism Design Theory" - Myerson (Nobel lecture)

### Crypto-Specific
- "Flash Boys 2.0" - MEV paper
- "SoK: DeFi Attacks" - Systemization of DeFi exploits
- "Clockwork Finance" - MEV and mechanism design
- Paradigm research blog

### Tools
- Nashpy (Python game theory library)
- Gambit (game theory software)
- Agent-based modeling frameworks
