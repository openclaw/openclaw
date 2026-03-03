---
name: moonpay-check-wallet
description: Check wallet balances and holdings. Use for "what's in my wallet", portfolio breakdown, token balances, allocation percentages, and USD values.
tags: [portfolio]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Check wallet

## Goal

List all token balances in a wallet with USD values, allocation breakdown, and total portfolio value.

## Commands

```bash
# List balances for a Solana wallet
mp token balance list --wallet <address> --chain solana

# List balances for an EVM wallet
mp token balance list --wallet 0x... --chain ethereum
mp token balance list --wallet 0x... --chain base

# Find wallet address
mp wallet list
```

## Supported chains

`solana`, `ethereum`, `base`, `polygon`, `arbitrum`, `optimism`

## Workflow

1. Run `mp wallet list` to find the user's wallet address.
2. Run `mp token balance list --wallet <address> --chain solana`.
3. Sort holdings by USD value descending.
4. Calculate allocation percentages (each holding's USD / total USD).
5. Present: top holdings, dust balances, total value.

## Example flow

1. User: "What's in my wallet?" or "Generate a portfolio report."
2. Run: `mp token balance list --wallet <address> --chain solana`
3. Present:
   - **Total value:** $168.05
   - **SOL** — 0.61 ($51.87) — 30.9%
   - **WBTC** — 0.00127 ($85.48) — 50.9%
   - **USDC** — 29.81 ($29.81) — 17.7%
   - **Dust:** none

## Output formats

Use `mp -f table token balance list ...` for a quick table view, or `mp -f json ...` for programmatic processing.

## Related skills

- **moonpay-auth** — Set up wallets if none exist.
- **moonpay-discover-tokens** — Research specific tokens in the portfolio.
