---
name: moonpay-deposit
description: Create deposit links that accept crypto from any chain and auto-convert to stablecoins. No login required.
tags: [payments]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Crypto Deposits

## Goal

Create a deposit link that generates multi-chain deposit addresses. Anyone can send crypto from Solana, Ethereum, Bitcoin, or Tron — it automatically converts to a stablecoin and settles to the specified destination wallet.

No login required. This is a permissionless tool.

## Command

```bash
mp deposit create \
  --name <label> \
  --wallet <destination-address> \
  --chain <destination-chain> \
  --token <stablecoin>
```

## Supported destination chains

`solana`, `ethereum`, `base`, `polygon`, `arbitrum`, `bnb`

## Supported tokens

- `USDC` — available on all chains
- `USDT` — available on all chains
- `USDC.e` — bridged USDC, Polygon only

## How it works

1. Run `mp deposit create` with a name, destination wallet, chain, and token.
2. Helio generates deposit addresses on Solana, Ethereum, Bitcoin, and Tron.
3. Share the deposit URL or a QR code with anyone who wants to send you crypto.
4. When someone sends any token to a deposit address, Helio auto-converts it to the chosen stablecoin and delivers it to your destination wallet.
5. Use `mp deposit transaction list --id <deposit-id>` to check incoming payments.

## Example flow

1. User: "I want to accept crypto payments as USDC on my Base wallet."
2. Run: `mp deposit create --name "My Payments" --wallet 0xf1D8...5036 --chain base --token USDC`
3. The output includes:
   - **Deposit URL** — shareable link for senders
   - **Deposit addresses** — one per chain (Solana, Ethereum, Bitcoin, Tron)
   - **QR codes** — one per deposit address, for easy scanning
   - **Instructions** — explaining how the deposit works
4. Share the URL, QR code, or address with anyone to receive funds.

## Notes

- No login or account required — deposits are permissionless.
- Senders can send any token from any supported chain.
- Funds are auto-converted to the chosen stablecoin on the destination chain.
- Each deposit creates unique addresses — don't reuse addresses from different deposits.
- The deposit URL opens a web page where senders can choose how to pay.

## Related skills

- **moonpay-check-wallet** — Check balances after receiving deposits.
- **moonpay-virtual-account** — Fiat on-ramp (bank to stablecoin).
- **moonpay-auth** — Login and wallet setup.
