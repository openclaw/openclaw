# Leverage Trading Reference

Trade with leverage using Avantis perpetuals on Base.

## Overview

Avantis offers long/short positions on crypto, forex, and commodities via perpetuals on Base.

**Chain**: Base
**Protocol**: [Avantis](https://docs.avantisfi.com/)

### Leverage Limits

| Asset Class | Max Leverage |
|-------------|-------------|
| Crypto | 50x |
| Forex | 100x |
| Commodities | 100x |

## Supported Markets

### Cryptocurrency
BTC, ETH, SOL, ARB, AVAX, BNB, DOGE, LINK, OP, MATIC

### Forex
- EUR/USD - Euro vs US Dollar
- GBP/USD - British Pound vs US Dollar
- USD/JPY - US Dollar vs Japanese Yen
- AUD/USD - Australian Dollar vs US Dollar
- USD/CAD - US Dollar vs Canadian Dollar

### Commodities
- XAU (Gold)
- XAG (Silver)
- WTI (Crude Oil)
- NATGAS (Natural Gas)

## Prompt Examples

**Open positions:**
- "Open a 5x long on ETH with $100"
- "Short Bitcoin with 10x leverage using $50"
- "Long Gold with 2x leverage"
- "Open 3x long SOL position"

**With risk management:**
- "Long ETH 5x with stop loss at $3000"
- "Short BTC 10x with take profit at 20%"
- "Long SOL 3x with SL at $150 and TP at $200"
- "5x long EUR/USD with stop loss at 1.08"

**View positions:**
- "Show my Avantis positions"
- "What leverage trades do I have open?"
- "My open positions"
- "PnL on my ETH long"

**Close positions:**
- "Close my ETH long"
- "Exit all my Avantis positions"
- "Close 50% of my BTC short"
- "Take profit on my SOL position"

## Position Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| **Leverage** | 1x to 50x crypto, 100x forex/commodities | "5x leverage" |
| **Collateral** | Amount to use as margin | "$100", "0.1 ETH" |
| **Direction** | Long (price up) or Short (price down) | "long", "short" |
| **Stop Loss** | Auto-close to limit losses | "stop loss at $3000" |
| **Take Profit** | Auto-close to lock in gains | "take profit at $4000" |

## How Leverage Works

### Long Position Example
- Open 5x long ETH with $100 at $3,000
- Effective position: $500 worth of ETH
- If ETH → $3,300 (+10%): Gain $50 (50% profit)
- If ETH → $2,700 (-10%): Lose $50 (50% loss)
- If ETH → $2,400 (-20%): Position liquidated

### Short Position Example
- Open 5x short BTC with $100 at $50,000
- If BTC → $45,000 (-10%): Gain $50 (50% profit)
- If BTC → $55,000 (+10%): Lose $50 (50% loss)
- If BTC → $60,000 (+20%): Position liquidated

## Leverage Guidelines

| Risk Level | Leverage | Use Case | Liquidation Risk |
|------------|----------|----------|------------------|
| Conservative | 1-3x | Long-term views | Low |
| Moderate | 3-10x | Swing trading | Medium |
| Aggressive | 10-25x | Short-term scalps | High |
| Extreme | 25x+ | Expert only | Very High |

## Liquidation

**What is liquidation?**
- Position is automatically closed
- Happens when losses approach collateral amount
- You lose all collateral for that position

**Liquidation Price Calculation:**
- Long position: Entry price × (1 - 1/leverage)
- Short position: Entry price × (1 + 1/leverage)

**Examples:**
- 5x long ETH at $3,000: Liquidated ~$2,400 (-20%)
- 10x short BTC at $50,000: Liquidated ~$55,000 (+10%)
- 2x long SOL at $100: Liquidated ~$50 (-50%)

## Risk Management

### Stop Loss (SL)
- Set maximum acceptable loss
- Closes position automatically
- Protects from larger losses
- **Recommended for all positions**

### Take Profit (TP)
- Set profit target
- Closes position when reached
- Locks in gains
- Good for planned exits

### Position Sizing
- Start with small amounts
- Risk only 1-5% of capital per trade
- Don't use full balance as collateral
- Keep reserve for other opportunities

## Funding Rates

**What are funding rates?**
- Periodic fee between longs and shorts
- Usually every 8 hours
- Can be positive or negative
- Affects profitability on long holds

**How they work:**
- If rate is positive: Longs pay shorts
- If rate is negative: Shorts pay longs
- Typically 0.01% - 0.1% per period

**Impact:**
- Short-term trades: Minimal
- Long holds: Can add up
- Check before opening position

## Common Issues

| Issue | Resolution |
|-------|------------|
| Insufficient collateral | Add more funds to wallet |
| Asset not supported | Check available markets list |
| Position liquidated | Reduce leverage or add more collateral |
| High funding rate | Consider closing and reopening |
| Slippage | Use smaller position size |
| Cannot close | Market might be paused (rare) |

## Advanced Strategies

### Hedging
- Open opposite position on same asset
- Protects against adverse moves
- Locks in current value

### Scaling In/Out
- Build position gradually
- Take partial profits
- Average entry price
- Manage risk dynamically

### Cross-Asset Arbitrage
- Long one asset, short related asset
- Example: Long ETH, short BTC
- Profit from spread changes
- Requires market knowledge

## Best Practices

### Before Opening Position
1. **Check price** - Confirm entry is good
2. **Set stop loss** - Decide max loss upfront
3. **Calculate liquidation** - Know your risk
4. **Check funding** - Consider costs
5. **Have a plan** - Know exit strategy

### While Position Open
1. **Monitor regularly** - Markets move fast
2. **Adjust stops** - Trail profits upward
3. **Watch funding** - Rates can change
4. **Stay informed** - Follow news
5. **Don't overtrade** - Be patient

### Closing Position
1. **Take profits** - Don't be greedy
2. **Cut losses** - Accept when wrong
3. **Learn** - Analyze what worked/didn't
4. **Record** - Keep trade journal
5. **Rest** - Don't immediately jump into next trade

## Risk Warnings

⚠️ **High Risk Activity**
- Can lose entire collateral quickly
- Leverage amplifies both gains and losses
- Liquidation is permanent
- Not suitable for beginners
- Only use money you can afford to lose

⚠️ **Market Volatility**
- Crypto is highly volatile
- Flash crashes can liquidate positions
- Weekend markets can be thin
- News can cause rapid moves

⚠️ **Technical Risks**
- Smart contract risk
- Oracle failures (rare)
- Network congestion
- Gas spikes on busy days

## Tips for Beginners

1. **Start small** - Test with $10-20
2. **Low leverage** - Use 2-3x maximum
3. **Always use stop loss** - Non-negotiable
4. **Close daily** - Don't hold overnight initially
5. **Paper trade first** - Practice without real money
6. **Learn from losses** - They will happen
7. **Don't revenge trade** - Take breaks after losses

## Tips for Experienced Traders

1. **Manage multiple positions** - Diversify leverage exposure
2. **Use TP/SL ratios** - 2:1 or 3:1 reward:risk minimum
3. **Consider funding** - Factor into long-term holds
4. **Scale positions** - Don't go all-in at once
5. **Hedge strategically** - Use shorts to protect longs
6. **Monitor correlation** - Related assets move together
7. **Take regular profits** - Lock in winners

## Resources

- **Avantis Documentation**: https://docs.avantisfi.com/
- **Funding Rate History**: Plan long-term holds
- **Market Statistics**: Analyze trading data
- **Liquidation Calculator**: Estimate risk

---

**Remember**: Leverage trading is a tool, not a get-rich-quick scheme. Most traders lose money. Start small, learn continuously, and never risk more than you can afford to lose.
