# Polymarket Reference

Interact with Polymarket prediction markets.

## Overview

Polymarket is a decentralized prediction market where users can search markets, view odds, place bets, and manage positions.

**Chain**: Polygon (uses USDC.e for betting)

## Prompt Examples

**Search markets:**
- "Search Polymarket for election markets"
- "What prediction markets are trending?"
- "Find markets about crypto"
- "Show Polymarket sports markets"

**Check odds:**
- "What are the odds Trump wins the election?"
- "Check the odds on the Eagles game"
- "Polymarket odds for ETF approval"
- "What's the probability of [event]?"

**Place bets:**
- "Bet $10 on Yes for Trump winning"
- "Place $5 on the Eagles to win"
- "Buy $20 of Yes shares on [market]"
- "Bet on No for [event]"

**View positions:**
- "Show my Polymarket positions"
- "What bets do I have active?"
- "My Polymarket portfolio"

**Redeem winnings:**
- "Redeem my Polymarket positions"
- "Cash out my resolved bets"
- "Claim my winnings"

## How Betting Works

### Share-Based System
- You buy shares of "Yes" or "No" outcomes
- Share price reflects market probability
  - $0.60 = 60% chance according to market
  - $0.20 = 20% chance
- If your outcome wins, shares pay $1.00 each
- Profit = $1.00 - purchase price (per share)

### Example
**Bet $10 on "Yes" at $0.60 price:**
- Receive: ~16.67 shares
- If Yes wins: Get $16.67 (profit: $6.67)
- If No wins: Lose $10

### Return on Investment
- Better odds (lower price) = higher potential return
- Price $0.10 → 10x return if wins
- Price $0.90 → 1.11x return if wins

## Auto-Bridging

If you don't have USDC on Polygon:
- Bankr automatically bridges from another chain
- Uses your available stablecoins (USDC/USDT)
- Optimizes for lowest fees
- Typically completes in minutes

## Market Types

| Category | Examples |
|----------|----------|
| Politics | Elections, legislation, appointments |
| Sports | Game outcomes, championships, player stats |
| Crypto | Price predictions, ETF approvals, launches |
| Culture | Awards shows, entertainment events |
| Business | Company earnings, acquisitions, product launches |
| World Events | Geopolitics, natural events, social trends |

## Market Phases

### Active Markets
- Open for betting
- Prices fluctuate with news
- Can buy or sell shares

### Closed Markets
- No new bets accepted
- Outcome determined
- Awaiting resolution

### Resolved Markets
- Outcome confirmed
- Winners can redeem
- Losers get nothing

## Common Issues

| Issue | Resolution |
|-------|------------|
| Market not found | Try different search terms, check spelling |
| Insufficient USDC | Add USDC or let auto-bridge handle it |
| Market closed | Can't bet on closed/resolved markets |
| Low liquidity | May get worse prices on small markets |
| Slippage | Large bets may move price against you |

## Tips for Success

### Research
1. Read market details carefully
2. Check resolution criteria
3. Review similar past markets
4. Follow news about the event

### Strategy
1. **Start small** - Test with small amounts
2. **Diversify** - Spread risk across markets
3. **Think probability** - If you think real odds > market odds, bet Yes
4. **Sell early** - Can sell shares before resolution
5. **Compound** - Reinvest winnings

### Timing
1. **Early bets** - Better odds before news breaks
2. **React fast** - Odds change quickly with news
3. **Redeem promptly** - Claim winnings soon after resolution

### Risk Management
1. Never bet more than you can afford to lose
2. Understand the outcome criteria
3. Consider worst-case scenarios
4. Don't let emotions drive decisions
5. Set a budget and stick to it

## Market Liquidity

- **High liquidity** - Easy to buy/sell, stable prices
- **Low liquidity** - Harder to exit, price slippage
- Check volume before large bets
- Popular markets have better liquidity

## Resolution Process

1. **Event occurs** - Real-world outcome determined
2. **Market closes** - No more betting
3. **Resolution** - Polymarket resolves via UMA oracle based on outcome criteria
4. **Winners paid** - Shares worth $1 each
5. **Losers** - Shares become worthless

## Advanced Features

### Selling Shares
- Can sell before resolution
- Lock in profits or cut losses
- Price depends on current odds

### Partial Positions
- Don't have to go all-in
- Can build position over time
- Average your entry price

### Market Making
- Provide liquidity to earn fees
- Advanced strategy
- Requires understanding of odds

## Responsible Betting

- Set limits before you start
- Don't chase losses
- Take breaks
- Betting is not guaranteed profit
- Only use money you can afford to lose

## Best Practices

1. **Read carefully** - Understand resolution criteria
2. **Check sources** - Official resolution sources
3. **Start small** - Learn with small bets
4. **Track record** - Keep notes on your bets
5. **Stay informed** - Follow news about your markets
6. **Redeem quickly** - Don't leave money on table
