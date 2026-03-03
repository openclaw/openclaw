---
name: moonpay-discover-tokens
description: Search for tokens, check prices, get trading briefs, and evaluate risk. Use for token research, "is this token safe?", price checks, and market analysis.
tags: [research]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Discover tokens

## Goal

Search for tokens, retrieve market data, generate trading briefs, and assess risk — all from one skill.

## Commands

```bash
# Search by name or symbol
mp token search --query "BONK" --chain solana

# Get full details for a specific token
mp token retrieve --token <mint-address> --chain solana

# See what's trending
mp token trending list --chain solana
```

## Supported chains

`solana`, `ethereum`, `base`, `polygon`, `arbitrum`, `optimism`

## Workflow

1. Search by name/symbol with `mp token search`.
2. Use the returned address to get details with `mp token retrieve`.
3. Assess risk and generate a brief from the market data.

## Trading brief format

When the user wants a brief or analysis, format the output like:

```
BONK (DezX...pump) — mcap $850M, liq $12M, vol24 $45M
  momentum: 1h +2.3%, 4h -0.5%, 24h +8.1%
  activity: trades24 12,500, wallets24 3,200
  note: healthy volume, broad wallet distribution
```

## Risk assessment

When the user asks "is this safe?" or wants to evaluate an unknown token, check these indicators from the market data:

1. **Liquidity** — Under $10K is a red flag.
2. **Volume pattern** — Sudden spikes with no context = suspicious.
3. **Buy/sell ratio** — Extremely one-sided trading = dump risk.
4. **Unique wallets** — Very few unique wallets = concentrated activity.
5. **Market cap vs liquidity** — Huge mcap with tiny liquidity = inflated, hard to exit.
6. **Price volatility** — Extreme short-term swings (>50% in 1h) = high risk.

Present a risk summary with traffic-light ratings. This is a heuristic check based on market data, not a smart contract audit — always recommend caution with unknown tokens.

## Example flows

**Price check:**

1. User: "What's the price of BONK?"
2. Run: `mp token search --query "BONK" --chain solana`
3. Present: name, symbol, price, 24h change, volume, liquidity.

**Risk check:**

1. User: "Is BONK safe to buy?"
2. Run: `mp token search --query "BONK" --chain solana` then `mp token retrieve --token <address> --chain solana`
3. Present risk indicators with ratings.

## Related skills

- **moonpay-swap-tokens** — Trade after research.
- **moonpay-buy-crypto** — Buy with fiat after research.
- **moonpay-check-wallet** — Check your current holdings.
