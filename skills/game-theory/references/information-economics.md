# Information Economics

Strategic implications of asymmetric information in crypto.

## Core Concepts

### Asymmetric Information

One party knows something others don't.

**In crypto:**
- Team knows roadmap, code quality
- Insiders know upcoming announcements
- Whales know their trading intentions
- MEV searchers know mempool state

### Adverse Selection (Hidden Information)

Before transaction: One party has private information.

**Examples:**
- Token buyers don't know if team will deliver
- LPs don't know if incoming trade is informed
- Lenders don't know borrower's true risk

**Result:** Market breakdown or inefficient pricing.

### Moral Hazard (Hidden Action)

After agreement: One party takes unobserved actions.

**Examples:**
- Protocol team effort after token sale
- Borrower risk-taking after loan
- Validator behavior after delegation

**Result:** Suboptimal effort, excessive risk-taking.

### Signaling

Informed party takes costly action to reveal information.

**Examples:**
- Team locks tokens (signals commitment)
- Protocol gets audited (signals security)
- Whale accumulates publicly (signals conviction)

**Requirements for effective signal:**
- Costly to fake
- Observable by uninformed party
- Correlated with true quality

### Screening

Uninformed party designs mechanism to reveal information.

**Examples:**
- Tiered token sales (whales vs. retail)
- Collateral requirements (reveal risk tolerance)
- Usage-based airdrops (reveal genuine users)

## Information Problems in Crypto

### The Lemon Problem

**Classic framing:** Used car market with unknown quality.

**Crypto version:** Token market with unknown fundamentals.

**Dynamics:**
1. Buyers can't distinguish good from bad projects
2. Offer average price
3. Good projects exit (unfairly priced)
4. Only bad projects remain
5. Market fails

**Mitigation:**
- Reputation systems
- Audits and due diligence
- Skin in the game (vesting)
- Verifiable credentials

### Insider Trading

**Information advantage:** Team/insiders know material non-public info.

**Game theory:**
- Insiders can front-run announcements
- Retail always at disadvantage
- Erodes market legitimacy

**Crypto specifics:**
- Pseudonymous = hard to detect
- On-chain = evidence exists
- Global = unclear jurisdiction

**Mitigation:**
- Trading blackout periods
- Delayed announcements
- On-chain surveillance
- Community monitoring

### MEV as Information Asymmetry

**Searchers know:**
- Pending transactions (mempool)
- Price impact of trades
- Arbitrage opportunities

**Users don't know:**
- Their order will be sandwiched
- True execution price
- Alternative routes

**Game theory:**
- Information advantage converts to profit
- Users pay invisible tax
- Arms race in information acquisition

### Oracle Manipulation

**Attacker information advantage:**
- Knows when price will be manipulated
- Can position before manipulation
- Profits from temporary deviation

**Defense requires:**
- Multiple data sources
- Manipulation-resistant aggregation
- Economic security (cost > profit)

## Signaling Mechanisms

### Token Vesting

**Signal:** Team locks tokens for extended period.

**What it signals:**
- Long-term commitment
- Confidence in future value
- Alignment with holders

**Why it works:**
- Costly if team wants to exit
- Observable on-chain
- Correlated with quality (bad teams want out)

**Limitations:**
- Can still build other revenue streams
- Delayed rug is still rug
- Linear vesting still creates sell pressure

### Audits and Certifications

**Signal:** Pay for external review.

**What it signals:**
- Code quality (somewhat)
- Commitment to security
- Professionalism

**Why it works:**
- Costly (audits expensive)
- Third-party verification
- Reputation at stake (auditor's)

**Limitations:**
- Audits miss bugs (many hacked protocols were audited)
- Quality varies widely
- May just be checkbox exercise

### Public Building

**Signal:** Develop openly, share progress.

**What it signals:**
- Technical competence
- Genuine product development
- Community orientation

**Why it works:**
- Costly to fake (requires actual work)
- Observable by technical community
- Builds reputation over time

**Limitations:**
- Competitors can copy
- Hard for non-technical observers to evaluate
- Doesn't guarantee business success

### Treasury Diversification

**Signal:** Protocol converts native token to stables.

**What it signals:**
- Planning for long-term
- Responsible financial management
- Reduced dependency on token price

**Why it works:**
- Reduces upside from token pump
- Shows operational thinking
- Aligns with sustainability

**Limitations:**
- May signal lack of confidence
- Creates sell pressure
- Timing matters

## Screening Mechanisms

### Sybil Screening

**Problem:** Distinguish real users from fake.

**Approaches:**

| Method | What It Screens For | Limitations |
|--------|---------------------|-------------|
| Minimum balance | Financial commitment | Excludes poor users |
| History-based | Past behavior | Attackers build history |
| Social graph | Network position | Can be fabricated |
| Proof of personhood | Unique human | Privacy concerns |
| Activity thresholds | Engagement | Can be botted |

### Risk Screening in Lending

**Problem:** Borrowers know their risk better than lenders.

**Approaches:**
- Collateral requirements (reveal risk tolerance)
- Interest rate tiers (self-selection)
- Credit scores (on-chain history)
- Social vouching

**Trade-off:** Better screening = less participation.

### Investor Screening

**Problem:** Distinguish committed investors from flippers.

**Approaches:**
- Lock-up requirements
- Vesting schedules
- Participation requirements
- Reputation checks

## Game-Theoretic Equilibria

### Pooling Equilibrium

All types take same action, information not revealed.

**Example:** All projects get audited (both good and bad).

**Result:** Audit doesn't distinguish quality.

### Separating Equilibrium

Different types take different actions, information revealed.

**Example:** Only good projects can afford long vesting.

**Result:** Vesting reveals quality.

### Partial Pooling

Some separation, some pooling.

**Example:** Best and worst projects don't get audited (too good to need / can't afford), middle gets audited.

## Information Design

### Strategic Information Revelation

**Question:** What should informed party reveal?

**Considerations:**
- Reveal good news, hide bad? (But then silence = bad news)
- Commit to full transparency? (May reveal competitive info)
- Selective disclosure? (Legal/ethical issues)

### Commitment Devices

**Problem:** Can't credibly commit to future actions.

**Solution:** Smart contracts as commitment.

**Examples:**
- Token vesting contracts (can't unlock early)
- Time-locked governance (can't execute immediately)
- Bonded assertions (lose stake if wrong)

**Game theory value:** Converts non-credible to credible commitments.

## Practical Applications

### Due Diligence Framework

**Information to gather:**
1. Team (background, reputation, previous projects)
2. Technology (code quality, audits, novel vs. fork)
3. Tokenomics (distribution, vesting, utility)
4. Community (size, engagement quality, organic vs. paid)
5. Competitive position (moat, differentiation)

**Red flags (information asymmetry indicators):**
- Anonymous team with large unlocked allocation
- Unverified claims about partnerships
- Unusual contract patterns
- Paid promotion without disclosure

### Reputation Systems

**Design considerations:**
- What actions are observable?
- How to aggregate into reputation?
- How to prevent gaming?
- How to allow recovery from mistakes?

**Game theory:**
- Reputation is valuable → incentivizes good behavior
- Must be hard to fake → costly signals
- Must matter → affects future opportunities
