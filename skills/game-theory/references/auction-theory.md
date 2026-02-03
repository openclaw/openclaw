# Auction Theory

Game theory of competitive bidding mechanisms.

## Auction Formats

### First-Price Sealed Bid

**Rules:**
- Bidders submit sealed bids
- Highest bid wins
- Winner pays their bid

**Equilibrium strategy:**
- Bid below true value (shade bid)
- Amount of shading depends on number of bidders, value distribution
- More bidders → less shading

**Crypto applications:**
- Most NFT auctions
- Block space auctions (effectively)
- MEV bundle auctions

### Second-Price Sealed Bid (Vickrey)

**Rules:**
- Bidders submit sealed bids
- Highest bid wins
- Winner pays second-highest bid

**Dominant strategy:** Bid exactly your true value.

**Why?**
- Bid higher: Risk paying more than value
- Bid lower: Risk losing when you'd profit
- Bid true value: Optimal regardless of others

**Crypto applications:**
- Some NFT platforms (rare)
- Theoretical ideal for many mechanisms

### English Auction (Ascending)

**Rules:**
- Price starts low, increases
- Bidders drop out as price rises
- Last remaining bidder wins at final price

**Strategically equivalent to second-price** for independent private values.

**Crypto applications:**
- Live NFT auctions
- Real-time bidding interfaces

### Dutch Auction (Descending)

**Rules:**
- Price starts high, decreases
- First bidder to accept wins at that price

**Strategically equivalent to first-price.**

**Crypto applications:**
- Fair launches (price discovery)
- Token sales
- Reduces gas wars

### All-Pay Auction

**Rules:**
- All bidders pay their bids
- Highest bid wins

**Game theory:**
- Aggressive bidding (since you pay regardless)
- Expected revenue can exceed value
- Models competitive lobbying, rent-seeking

**Crypto applications:**
- Gas price auctions (failed txs still pay)
- Priority fee competition

## Revenue Equivalence Theorem

**Statement:** Under certain conditions, all standard auctions yield the same expected revenue.

**Conditions:**
- Risk-neutral bidders
- Independent private values
- Symmetric bidders
- Payment only by winner

**Implication:** Auction format choice doesn't affect expected revenue.

**When it breaks:**
- Risk-averse bidders
- Common values (winner's curse)
- Asymmetric information
- Collusion possible

## Common Value Auctions

**Setting:** Object has same value to all bidders, but value is uncertain.

**Example:** Oil drilling rights, token launch pricing.

### Winner's Curse

**Problem:** Winner tends to be the bidder who most overestimated value.

**Game theory:**
- Rational bidders shade bids to account for this
- Winning = signal you may have overestimated
- Naive bidders suffer losses

**Crypto relevance:**
- NFT speculators often fall victim
- Token launch prices may reflect winner's curse
- Sophisticated bidders adjust

## Auction Design for Crypto

### NFT Auctions

**Considerations:**
- Gas costs affect minimum viable bid
- Front-running risk in on-chain bidding
- Reserve prices and creator royalties
- Bundle sales and lots

**Common issues:**
- Shill bidding (fake bids to raise price)
- Wash trading (fake volume)
- Sniping (last-second bids)

### Token Sale Auctions

**Dutch auction for fair launch:**
1. Price starts high
2. Decreases over time
3. Participants commit funds at current price
4. Auction ends when all tokens allocated
5. Everyone pays final clearing price

**Advantages:**
- Price discovery
- No gas wars
- Fair access (time preference only)

**Challenges:**
- Requires patience from buyers
- Price may fall below expectations
- Can be gamed with large buys

### MEV Auctions

**Flashbots-style:**
- Searchers bid to builders
- Builders bid to proposers
- Auction for transaction ordering rights

**Design goals:**
- Efficient MEV extraction
- Reduce negative externalities
- Distribute value fairly

### Liquidation Auctions

**Design considerations:**
- Speed (faster = more stable system)
- Efficiency (maximize recovery)
- Participation (enough liquidators)

**Common formats:**
- Fixed discount (simple, may be too generous)
- Dutch auction (price discovery)
- Batch auction (efficient, slower)

## Collusion in Auctions

### Bid Rigging

**Mechanisms:**
- Designated winner (others don't bid)
- Bid rotation (take turns winning)
- Compensation (side payments to losers)

**Defense:**
- Reserve prices
- Sealed bids
- Multiple rounds
- Detection algorithms

### On-Chain Collusion

**Easier in crypto because:**
- Pseudonymous (hard to identify colluders)
- Smart contracts can enforce agreements
- DAOs can coordinate bidding

**Harder in crypto because:**
- Transparent (all bids visible)
- Permissionless (anyone can bid)
- Competitive (many potential entrants)

## Optimal Auction Design

### Myerson's Optimal Auction

**For revenue-maximizing seller:**
- Set reserve price above zero
- Exclude low-value bidders
- Optimal reserve depends on value distribution

**Crypto application:**
- NFT reserve prices
- Token sale minimums
- Validator slot auctions

### Mechanism Design Trade-offs

| Goal | Tension |
|------|---------|
| Revenue maximization | vs. Participation |
| Efficiency (allocation to highest value) | vs. Revenue |
| Simplicity | vs. Optimality |
| Fairness | vs. Efficiency |
| Speed | vs. Price discovery |

## Practical Guidelines

### For Sellers

1. **Know your buyers:** Are values private or common?
2. **Set appropriate reserves:** Too high = no sale, too low = leaving money
3. **Choose format for goals:** Revenue vs. speed vs. fairness
4. **Prevent collusion:** Mix of bidders, sealed bids
5. **Consider UX:** Complex auctions deter participation

### For Bidders

1. **Understand format:** Know what strategy is optimal
2. **Avoid winner's curse:** Discount for common value components
3. **Watch for shill bids:** Unusual bidding patterns
4. **Consider all-in costs:** Gas, time, opportunity cost
5. **Don't get emotional:** Set max bid, stick to it
