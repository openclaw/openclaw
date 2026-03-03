---
name: moonpay-fund-polymarket
description: Install the Polymarket CLI and fund its wallet with USDC.e and POL on Polygon via MoonPay.
tags: [trading, setup, polymarket, polygon]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Fund Polymarket

## Goal

Install the Polymarket CLI and fund its wallet with POL (gas) and USDC.e (trading) via MoonPay so it's ready to trade on Polymarket.

Polymarket runs on Polygon. To trade, the user needs:

- **POL** — native gas token for transaction fees
- **USDC.e** (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) — the token Polymarket uses for bets

## Key addresses

| Token        | Chain    | Address                                      |
| ------------ | -------- | -------------------------------------------- |
| POL (native) | Polygon  | `0x0000000000000000000000000000000000000000` |
| USDC.e       | Polygon  | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| ETH (native) | Ethereum | `0x0000000000000000000000000000000000000000` |

## Workflow

### 1. Install Polymarket CLI

Check if the Polymarket CLI is already installed:

```bash
polymarket --version
```

If not installed, download the binary from the [Polymarket CLI releases](https://github.com/Polymarket/polymarket-cli/releases) page. Verify the checksum against the published SHA-256 hash before installing:

```bash
# Download the binary for your platform from the releases page
# Verify the checksum, then install:
chmod +x polymarket && sudo mv polymarket /usr/local/bin/
```

### 2. Set up Polymarket wallet

Run the guided setup if no wallet exists:

```bash
polymarket setup
```

This creates a wallet, sets up a proxy wallet, and approves Polymarket contracts on Polygon.

Then get the wallet address:

```bash
polymarket wallet address
```

Use this address as the `--wallet` for all MoonPay funding commands below. EVM addresses are the same across all chains, so the Polymarket address works directly with MoonPay.

### 3. Check existing Polygon balances

```bash
mp token balance list --wallet <polymarket-address> --chain polygon
```

If the wallet already has POL and USDC.e, they're set.

### 4. Get POL for gas

Buy POL directly with fiat — easiest way to get gas on Polygon:

```bash
mp buy --token pol_polygon --amount 5 --wallet <polymarket-address> --email <email>
```

Alternatively, bridge ETH → POL if the user already has ETH:

```bash
mp token bridge \
  --from-wallet <wallet-name> --from-chain ethereum \
  --from-token 0x0000000000000000000000000000000000000000 \
  --from-amount 0.001 \
  --to-chain polygon \
  --to-token 0x0000000000000000000000000000000000000000
```

~$2-5 worth of POL covers hundreds of transactions.

### 5. Get USDC.e for trading

Bridge ETH on Ethereum to USDC.e on Polygon in one step:

```bash
mp token bridge \
  --from-wallet <wallet-name> --from-chain ethereum \
  --from-token 0x0000000000000000000000000000000000000000 \
  --from-amount 0.005 \
  --to-chain polygon \
  --to-token 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
```

Alternatively, if the user already has USDC on Ethereum, bridge it directly:

```bash
mp token bridge \
  --from-wallet <wallet-name> --from-chain ethereum \
  --from-token 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 \
  --from-amount 10 \
  --to-chain polygon \
  --to-token 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
```

### 6. Verify

```bash
mp token balance list --wallet <polymarket-address> --chain polygon
```

Confirm both POL and USDC.e are present.

### 7. Trade on Polymarket

Once funded, use the Polymarket CLI to trade:

```bash
polymarket markets search "query"           # find markets
polymarket clob price <token_id>            # check prices
polymarket clob market-order ...            # place orders
polymarket clob balance                     # check trading balance
```

## Tips

- `polymarket wallet address` gives you the address to fund — use it as `--wallet` in all MoonPay commands
- EVM addresses are shared across chains, so one address works for Polygon, Ethereum, Base, etc.
- Bridge times from Ethereum → Polygon are typically 5-20 seconds
- POL is very cheap for gas — a few dollars covers hundreds of transactions
- The fiat buy option (`mp buy`) is the fastest path if the user has no crypto yet

## Related skills

- **moonpay-swap-tokens** — Bridge commands and supported chains
- **moonpay-check-wallet** — Check Polygon balances
- **moonpay-buy-crypto** — Buy POL or ETH with fiat
