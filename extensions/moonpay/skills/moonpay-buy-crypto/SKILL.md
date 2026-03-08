---
name: moonpay-buy-crypto
description: Buy crypto with fiat via MoonPay. Returns a checkout URL to complete the purchase in a browser.
tags: [trading]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Buy crypto with fiat

## Goal

Generate a MoonPay checkout URL for buying crypto with a credit card or bank transfer. The user completes the purchase in their browser.

## Command

```bash
mp buy \
  --token <currency-code> \
  --amount <usd-amount> \
  --wallet <destination-address> \
  --email <buyer-email>
```

## Supported tokens

`btc`, `sol`, `eth`, `trx`, `pol_polygon`, `usdc`, `usdc_sol`, `usdc_base`, `usdc_arbitrum`, `usdc_optimism`, `usdc_polygon`, `usdt_trx`, `eth_polygon`, `eth_optimism`, `eth_base`, `eth_arbitrum`

## Example flow

1. User: "I want to buy $50 of SOL with my credit card."
2. Run: `mp buy --token sol --amount 50 --wallet <address> --email user@example.com`
3. Open the returned checkout URL in the user's browser so they can complete the purchase.

## Notes

- This is fiat-to-crypto (credit card / bank), not a token swap.
- For token-to-token swaps, use the **moonpay-swap-tokens** skill instead.
- The `--amount` flag is in USD (e.g. `--amount 50` = $50 worth of the token).
- The `--token` flag uses MoonPay currency codes, not mint addresses.
- The checkout URL handles KYC and payment processing.

## Related skills

- **moonpay-swap-tokens** — Swap between tokens (no fiat).
- **moonpay-discover-tokens** — Search for tokens.
- **moonpay-auth** — Ensure user is logged in.
