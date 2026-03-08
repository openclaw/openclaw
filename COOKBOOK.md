# Money Maker Bot — Cookbook

Practical recipes for getting the most out of your financial intelligence assistant.
Each recipe is a self-contained prompt or workflow you can run directly.

---

## Table of Contents

1. [Morning Market Brief](#1-morning-market-brief)
2. [Sports Betting Edge Finder](#2-sports-betting-edge-finder)
3. [Portfolio Health Check](#3-portfolio-health-check)
4. [NFT Floor Alert Digest](#4-nft-floor-alert-digest)
5. [Kelly Bet Sizing Calculator](#5-kelly-bet-sizing-calculator)
6. [Market Sentiment Snapshot](#6-market-sentiment-snapshot)
7. [DFS Lineup Builder](#7-dfs-lineup-builder)
8. [Bet Journal End-of-Week Review](#8-bet-journal-end-of-week-review)
9. [Crypto Rebalance Check](#9-crypto-rebalance-check)
10. [Streak + Regression Screener](#10-streak--regression-screener)

---

## 1. Morning Market Brief

Get a concise morning briefing covering crypto prices, key fear/greed reading, and any major overnight news.

**Prompt:**

```
Give me a morning market brief. Include:
- BTC and ETH prices with 24h change
- Current Fear & Greed Index reading and what it means
- Top 3 news headlines affecting crypto today
- One actionable takeaway for my portfolio
```

**Skills used:** `market-sentiment`, `nft-tracker` (for on-chain data)

**Tip:** Pin this to a morning cron or daily Telegram message using the OpenClaw cron plugin:

```yaml
# Add to your openclaw config
crons:
  - id: morning-brief
    schedule: "0 8 * * *"
    message: "Give me a morning market brief."
    channel: telegram
```

---

## 2. Sports Betting Edge Finder

Find the best value bets for tonight's slate by comparing your model's win probabilities against live sportsbook lines.

**Prompt:**

```
Tonight's NBA slate:
- Celtics (-4.5) at Knicks
- Thunder (-8) vs Grizzlies
- Warriors (+2) at Lakers

For each game:
1. Tell me the implied win probability from the spread
2. Estimate the actual win probability based on team stats
3. Flag any games where our edge exceeds 3%
4. Calculate the Kelly bet size assuming $1,000 bankroll and half-Kelly
```

**Skills used:** `sports-odds`, `kelly-criterion`

---

## 3. Portfolio Health Check

Run a complete diagnostic on your current holdings.

**Prompt:**

```
Here's my current portfolio:
BTC: 0.5 (current price $X)
ETH: 3.2 (current price $X)
SOL: 25 (current price $X)

My targets are 60% BTC, 30% ETH, 10% SOL.

1. Calculate my current allocation percentages
2. Identify which positions have drifted more than 5% from target
3. Generate buy-only rebalancing trades to get back to target
4. Estimate the tax impact of any sells if I weren't using buy-only mode
```

**Skills used:** `portfolio-rebalancer`

---

## 4. NFT Floor Alert Digest

Track whether any of your watched collections are showing unusual floor movement.

**Prompt:**

```
Check the following NFT collections and tell me:
1. Current floor price
2. 24h floor change %
3. 7-day volume trend
4. Whether I should be paying attention (flag if floor moved > 10% in 24h)

Collections: BAYC, Azuki, CryptoPunks, DeGods
```

**Skills used:** `nft-tracker`

**Pro tip:** Set a threshold alert so the bot only messages you when floors move significantly:

```
Only alert me if any floor price moves more than 15% in 24 hours.
Check every 6 hours and send a Telegram message if triggered.
```

---

## 5. Kelly Bet Sizing Calculator

Quickly calculate optimal stake for any bet before you place it.

**Prompt:**

```
I want to bet on the Chiefs ML tonight.
- My model gives them a 62% win probability
- The current line is -145
- I have a $2,000 bankroll
- I use half-Kelly sizing

Calculate:
1. The implied probability from -145
2. My edge (if any)
3. Full Kelly percentage and dollar amount
4. Half-Kelly recommendation
5. Whether this is worth betting at all
```

**Skills used:** `kelly-criterion`

---

## 6. Market Sentiment Snapshot

Get a full read on current market conditions before making any moves.

**Prompt:**

```
Give me a full market sentiment snapshot:
1. Current Fear & Greed reading with 7-day trend
2. BTC Reddit mention count trend (rising or falling vs last week?)
3. Score 5 recent headlines as bullish/bearish/neutral
4. Current VIX level interpretation
5. Composite sentiment score and directional bias
6. Based on the above, should I be adding to positions, holding, or reducing exposure?
```

**Skills used:** `market-sentiment`

---

## 7. DFS Lineup Builder

Build an optimal DraftKings NBA lineup for tonight's slate.

**Prompt:**

```
Build me a DraftKings NBA lineup for tonight.

Slate:
[paste your DK player list with names, positions, salaries, and projections]

Rules:
- $50,000 salary cap
- 2 PG, 2 SG, 2 SF, 1 PF, 1 C
- Maximize projected points
- Avoid players with ownership > 40% (too chalky for tournaments)
- Suggest one contrarian option under 8% ownership with upside

Also tell me the best 2-player stack from the same game.
```

**Skills used:** `dfs-optimizer`

---

## 8. Bet Journal End-of-Week Review

Every Sunday, run this to understand where your edge is coming from.

**Prompt:**

```
Analyze my bet journal for the past 7 days and give me:
1. Overall record, units won/lost, and ROI
2. P&L broken down by sport
3. P&L broken down by bet type (ML, spread, total, props)
4. My average CLV — am I consistently beating the closing line?
5. Any bet types or sports where I'm consistently losing
6. Three specific adjustments I should make next week based on the data
```

**Skills used:** `bet-journal`

---

## 9. Crypto Rebalance Check

Set and forget — run this monthly to keep your portfolio on target.

**Prompt:**

```
Monthly portfolio check. My targets haven't changed (60/30/10 BTC/ETH/SOL).

Current holdings: [paste your holdings]

1. What's my current allocation?
2. What's drifted more than 5%?
3. Give me buy-only trades to rebalance
4. What would my portfolio value be if I'd rebalanced last month vs. held?
5. Is the current BTC dominance suggesting I should adjust my targets?
```

**Skills used:** `portfolio-rebalancer`, `market-sentiment`

---

## 10. Streak + Regression Screener

Find teams due for a turnaround before the market notices.

**Prompt:**

```
Screen tonight's NBA games for regression opportunities.

For each game in tonight's slate:
1. Check both teams' last 10 game SU and ATS records
2. Flag any team on a 5+ game win OR loss streak
3. Identify teams where win% doesn't match their point differential
4. Look for back-to-back situations (this is their 2nd game in 2 nights)
5. Rank the top 3 fade/back spots by regression signal strength

Tonight's games: [paste tonight's schedule]
```

**Skills used:** `streak-tracker`, `sports-odds`

---

## Combining Skills: Advanced Workflows

### The Full Pre-Bet Checklist

```
Before I place this bet [describe bet], run through:
1. Kelly sizing at my edge estimate
2. This team's current streak and regression signal
3. Market sentiment (is this a sharp or public bet?)
4. Any injury news affecting the line
5. Final recommendation: bet, pass, or reduce size
```

### The Opportunistic NFT Buyer

```
I have 0.5 ETH to deploy into NFTs.
1. Show me the 3 lowest-floor collections with positive 7-day volume trend
2. Check the current Fear & Greed index — is this a good time to buy NFTs?
3. What's the historical pattern for BAYC floors when Fear & Greed drops below 25?
4. Recommend whether to buy now or wait
```

### The Daily Alpha Email

Set up a daily digest combining all data sources into one Slack or Telegram message:

```yaml
# openclaw cron config
crons:
  - id: daily-alpha
    schedule: "0 7 * * *"
    message: |
      Daily alpha digest:
      1. Top crypto movers (24h)
      2. Fear & Greed reading + trend
      3. Any NFT collections with floor moves > 10%
      4. Tonight's best betting edges from the slate
      5. One stock or crypto trade idea based on sentiment
    channel: slack
```

---

## Tips

- **Be specific** — the more context you give (current price, exact odds, bankroll size), the better the output
- **Chain skills** — start with `market-sentiment` to get directional bias, then use `kelly-criterion` to size your bet
- **Use the journal** — all this analysis means nothing if you don't track results in `bet-journal`
- **Automate the boring stuff** — set up crons for the daily brief, weekly P&L review, and portfolio checks

---

_Built on [OpenClaw](https://github.com/openclaw/openclaw) — the personal AI assistant framework._
