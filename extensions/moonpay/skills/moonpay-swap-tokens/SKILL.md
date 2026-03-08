---
name: moonpay-swap-tokens
description: Swap tokens on the same chain or bridge tokens across chains. Use when the user wants to swap, bridge, or move tokens.
tags: [trading]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Swap or bridge tokens

## Goal

Swap tokens on the same chain, or bridge tokens across chains. Two commands:

- **`mp token swap`** — same chain, different tokens
- **`mp token bridge`** — cross chain

Both build via swaps.xyz, sign locally, broadcast, and register for tracking.

## Commands

### Swap (same chain)

```bash
mp token swap \
  --wallet <wallet-name> \
  --chain <chain> \
  --from-token <token-address> \
  --from-amount <amount> \
  --to-token <token-address>
```

Supports exact-out: use `--to-amount` instead of `--from-amount`.

### Bridge (cross chain)

```bash
mp token bridge \
  --from-wallet <wallet-name> \
  --from-chain <chain> \
  --from-token <token-address> \
  --from-amount <amount> \
  --to-chain <chain> \
  --to-token <token-address> \
  --to-wallet <wallet-name>  # optional, defaults to from-wallet
```

Supports exact-out: use `--to-amount` instead of `--from-amount`.

## Examples

### Same-chain swap (SOL → USDC on Solana)

```bash
mp token swap \
  --wallet main --chain solana \
  --from-token So11111111111111111111111111111111111111111 \
  --from-amount 0.1 \
  --to-token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

### Cross-chain bridge (ETH → USDC.e on Polygon)

```bash
mp token bridge \
  --from-wallet funded --from-chain ethereum \
  --from-token 0x0000000000000000000000000000000000000000 \
  --from-amount 0.003 \
  --to-chain polygon \
  --to-token 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
```

### ERC20 swap (auto-approves if needed)

```bash
mp token swap \
  --wallet funded --chain polygon \
  --from-token 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 \
  --from-amount 5 \
  --to-token 0x0000000000000000000000000000000000000000
```

## Supported chains

solana, ethereum, base, polygon, arbitrum, optimism, bnb, avalanche, bitcoin (bridges only)

## How it works

1. Resolves wallet name → address
2. Builds unsigned transaction via swaps.xyz (handles decimal conversion)
3. If ERC20 token needs approval, sends an approve transaction first, then re-builds
4. Signs locally — private key never leaves the machine
5. Broadcasts to the network
6. Registers for tracking

`token swap` calls `token bridge` under the hood with `from-chain` = `to-chain`.

## Tips

- If the user provides token names/symbols, resolve to addresses with `mp token search --query "USDC" --chain solana`
- Check balances first with `mp token balance list --wallet <address> --chain <chain>`
- Native tokens use `0x0000000000000000000000000000000000000000` (EVM) or `So11111111111111111111111111111111111111111` (Solana)

## Related skills

- **moonpay-discover-tokens** — Search for token addresses
- **moonpay-check-wallet** — Check balances before swapping
- **moonpay-auth** — Set up wallets for signing
