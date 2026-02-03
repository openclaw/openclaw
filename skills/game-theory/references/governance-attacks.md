# Governance Attacks

Game-theoretic analysis of how governance systems fail.

## The Governance Game

**Players:**
- Token holders (various sizes)
- Delegates
- Protocol team
- Attackers
- Affected users (often not token holders)

**The fundamental tension:** Those with governance power may not be those affected by decisions.

## Attack Categories

### 1. Plutocratic Capture

**Mechanism:** Wealthy actor acquires controlling stake.

**Game theory:**
- Cost of attack = cost to acquire 51% of voting power
- Profit = value extracted from protocol
- Attack is rational if Profit > Cost

**Calculation:**
```
Voting power needed: V (e.g., 51% of quorum)
Token price: P
Cost to acquire: V * P * (1 + slippage)
Extractable value: X
Attack profitable if: X > V * P * (1 + slippage)
```

**Real examples:**
- Beanstalk: $182M governance attack
- Build Finance: Complete protocol takeover

**Defenses:**
- High token market cap relative to TVL
- Time delays on execution
- Rage quit mechanisms
- Multi-sig vetoes

### 2. Flash Loan Governance

**Mechanism:** Borrow tokens, vote, return in same transaction.

**Game theory:**
- Cost = flash loan fee + gas
- Nearly zero capital requirement
- Only works if voting is instant

**Requirements for attack:**
- No lock-up period for voting
- No snapshot before proposal
- Flash loan liquidity available

**Defenses:**
- Snapshot at proposal creation
- Time-weighted voting power
- Lock-up requirements
- Delegation restrictions

### 3. Bribing Attacks

**Mechanism:** Pay token holders to vote a certain way.

**Types:**

**Direct bribing:**
- "Vote YES on Proposal X, receive $Y per token"
- Coordination via bribe platforms (Votium, Hidden Hand)

**Indirect bribing:**
- Offer staking rewards contingent on voting
- Airdrop promises for supporters

**Dark bribing:**
- Private deals with whales
- Quid pro quo arrangements
- Undetectable on-chain

**Game theory:**
- Cost of bribe per vote = marginal voter's reservation price
- Often very low (most voters are apathetic)
- Concentrated interests can outbid diffuse opposition

**Defenses:**
- Secret voting (reduces targeting)
- Conviction voting (time-weighted)
- Quadratic voting (expensive to buy large influence)
- Futarchy (separate values from beliefs)

### 4. Voter Apathy Exploitation

**Mechanism:** Low turnout allows minority control.

**Game theory:**
- Expected value of single vote ≈ 0 for small holders
- Rational to not participate (gas cost > impact)
- Creates opportunity for organized minorities

**Typical pattern:**
- Quorum: 4% of tokens
- Actual turnout: 2% of holders
- Effective control: ~2% of total supply

**Real examples:**
- Most DAO votes pass with <5% participation
- Quorum requirements routinely unmet
- Team/investor bloc often decisive

**Defenses:**
- Delegation (passive holders delegate)
- Incentivized voting (rewards for participation)
- Lower stakes decisions (reduce attack surface)
- Representative democracy models

### 5. Governance Extraction

**Mechanism:** Insiders use governance to extract value.

**Forms:**

**Treasury raids:**
- Propose "grants" to insider-controlled entities
- "Partnerships" with affiliated projects

**Salary manipulation:**
- Approve excessive compensation
- Hire friends/family

**Parameter manipulation:**
- Change fee structures to favor insiders
- Adjust emission to benefit specific holders

**Game theory:**
- Insiders have information advantage
- Costs distributed, benefits concentrated
- Difficult for outside observers to evaluate

**Defenses:**
- Transparency requirements
- Independent oversight
- Rage quit mechanisms
- Token holder activism

### 6. Proposal Spamming

**Mechanism:** Flood governance with proposals to exhaust voters.

**Game theory:**
- Defender must evaluate each proposal
- Attacker can generate cheaply
- Asymmetric costs

**Defenses:**
- Proposal deposits (refunded if passed)
- Spam filtering
- Delegate specialization

### 7. Last-Minute Attacks

**Mechanism:** Submit or modify proposals just before deadline.

**Game theory:**
- Reduces time for opposition to organize
- Exploits voter inattention
- Works best with short voting periods

**Defenses:**
- Minimum voting periods
- No late amendments
- Mandatory review periods

### 8. Social Engineering

**Mechanism:** Manipulate community sentiment to pass harmful proposals.

**Tactics:**
- Sybil sock puppets creating fake consensus
- Discord/forum manipulation
- Influencer coordination
- FUD against opposition

**Game theory:**
- Information asymmetry between attackers and voters
- Social proof exploitation
- Reputation laundering

**Defenses:**
- Verified identity systems
- Reputation tracking
- Independent analysis requirements
- Cooling-off periods

## Defense Mechanisms

### Time Locks

**Mechanism:** Delay between proposal passing and execution.

**Trade-off:**
- Longer delay = more time to detect attacks
- Longer delay = slower response to legitimate needs

**Typical values:** 24 hours to 7 days

### Optimistic Governance

**Mechanism:** Proposals pass unless challenged.

**Game theory:**
- Reduces burden on passive voters
- Shifts work to active monitors
- Requires effective challenge mechanism

**Design:**
- Challenge period
- Challenge bond
- Dispute resolution

### Rage Quit

**Mechanism:** Allow exit before proposal executes.

**Game theory:**
- Limits governance attack profitability
- Exit value = floor on extraction
- May cause coordination problems

**Implementation:**
- Window after vote, before execution
- Pro-rata share of treasury
- May exclude illiquid assets

### Veto Power

**Mechanism:** Designated party can block proposals.

**Types:**
- Security council veto
- Token holder supermajority override
- Time-limited during bootstrap

**Trade-off:**
- Protects against attacks
- Centralizes power
- Reduces legitimacy

### Quadratic Mechanisms

**Voting:** Vote power = sqrt(tokens)
**Funding:** Matching based on number of contributors, not amount

**Game theory:**
- Reduces plutocracy
- Increases Sybil vulnerability
- Requires identity/collusion resistance

### Conviction Voting

**Mechanism:** Vote weight increases the longer tokens are committed.

**Game theory:**
- Rewards conviction, punishes flash attacks
- Complex dynamics
- Can be gamed with advance positioning

### Futarchy

**Mechanism:** Vote on values, bet on beliefs.

**Game theory:**
- Separates normative from positive questions
- Harnesses prediction markets
- Experimental, limited deployment

## Governance Security Checklist

### Before Launching Governance

- [ ] TVL < 10x governance attack cost?
- [ ] Time lock on all critical functions?
- [ ] Snapshot-based voting?
- [ ] Rage quit mechanism?
- [ ] Multi-sig backstop during bootstrap?

### Ongoing Monitoring

- [ ] Track large token accumulation
- [ ] Monitor proposal quality
- [ ] Watch for coordinated voting
- [ ] Analyze voter participation trends
- [ ] Review executed proposal outcomes

### Red Flags

- [ ] Single entity approaching quorum threshold
- [ ] Unusual delegation patterns
- [ ] Last-minute proposal changes
- [ ] Coordinated social media campaigns
- [ ] Proposals benefiting narrow interests

## Case Studies

### Beanstalk ($182M)

**Attack:**
1. Attacker took flash loan of governance tokens
2. Proposed malicious proposal
3. Voted with borrowed tokens
4. Proposal passed and executed in same transaction
5. Drained protocol treasury

**Lessons:**
- Flash loan attacks are real
- No time lock = instant execution
- Snapshot must precede proposal

### Build Finance (100%)

**Attack:**
1. Attacker accumulated tokens quietly
2. Proposed to transfer treasury to attacker
3. Had enough votes to pass
4. Complete protocol capture

**Lessons:**
- Monitor token accumulation
- Emergency governance needed
- Rage quit would have helped

### Compound Proposal 62

**Near-attack:**
1. Proposal to distribute $24M to "DeFi Education Fund"
2. Controlled by small group
3. Passed despite controversy
4. Highlighted plutocracy issues

**Lessons:**
- "Legal" extraction is possible
- Community vigilance required
- Reputation effects may not deter

## Game-Theoretic Recommendations

### For Protocol Designers

1. **Make attacks expensive:** High quorum, time locks, rage quit
2. **Make extraction visible:** Transparency, monitoring
3. **Align incentives:** Token value tied to protocol health
4. **Limit governance scope:** Minimize attack surface
5. **Plan for failure:** Emergency mechanisms, upgradability

### For Token Holders

1. **Participate or delegate:** Don't be the apathetic majority
2. **Monitor proposals:** Set up alerts
3. **Coordinate defense:** Build coalitions against attacks
4. **Demand transparency:** Question complex proposals
5. **Exit if necessary:** Use rage quit if available

### For Attackers (to understand defense)

1. **Accumulate quietly:** Avoid detection
2. **Time proposals:** Exploit low-attention periods
3. **Divide opposition:** Propose multiple conflicting changes
4. **Use social engineering:** Control narrative
5. **Extract incrementally:** Many small raids vs. one big one
