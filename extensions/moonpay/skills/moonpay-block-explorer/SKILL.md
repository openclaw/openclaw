---
name: moonpay-block-explorer
description: Open transactions, wallets, and tokens in the correct block explorer. Use after swaps, bridges, or transfers to view results in the browser.
tags: [explorer]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Block explorer

## Goal

After any swap, bridge, or transfer, open the result in the correct block explorer. Also useful for viewing wallet addresses and token contract pages.

## Explorer URLs

| Chain     | Transaction                                 | Wallet                                           | Token                                          |
| --------- | ------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| solana    | `https://solscan.io/tx/{sig}`               | `https://solscan.io/account/{addr}`              | `https://solscan.io/token/{addr}`              |
| ethereum  | `https://etherscan.io/tx/{hash}`            | `https://etherscan.io/address/{addr}`            | `https://etherscan.io/token/{addr}`            |
| base      | `https://basescan.org/tx/{hash}`            | `https://basescan.org/address/{addr}`            | `https://basescan.org/token/{addr}`            |
| polygon   | `https://polygonscan.com/tx/{hash}`         | `https://polygonscan.com/address/{addr}`         | `https://polygonscan.com/token/{addr}`         |
| arbitrum  | `https://arbiscan.io/tx/{hash}`             | `https://arbiscan.io/address/{addr}`             | `https://arbiscan.io/token/{addr}`             |
| optimism  | `https://optimistic.etherscan.io/tx/{hash}` | `https://optimistic.etherscan.io/address/{addr}` | `https://optimistic.etherscan.io/token/{addr}` |
| bnb       | `https://bscscan.com/tx/{hash}`             | `https://bscscan.com/address/{addr}`             | `https://bscscan.com/token/{addr}`             |
| avalanche | `https://snowscan.xyz/tx/{hash}`            | `https://snowscan.xyz/address/{addr}`            | `https://snowscan.xyz/token/{addr}`            |
| bitcoin   | `https://mempool.space/tx/{txid}`           | `https://mempool.space/address/{addr}`           | —                                              |

## Open a transaction

After a swap or bridge, extract the chain and tx hash, then open:

```bash
# macOS
open "https://solscan.io/tx/5rQ52JVb6q7H..."

# Linux
xdg-open "https://etherscan.io/tx/0xabcd..."
```

### From swap/bridge output

`mp token swap` and `mp token bridge` return a result with the transaction signature. Use the chain to pick the correct explorer.

```bash
RESULT=$(mp -f compact token swap --wallet main --chain solana \
  --from-token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --from-amount 1 \
  --to-token So11111111111111111111111111111111111111111)

# Open in browser
SIG=$(echo "$RESULT" | jq -r '.signature')
open "https://solscan.io/tx/$SIG"
```

### From transaction list

`mp transaction list` returns transactions with `from.txHash` and `to.txHash`. Use the chain field to pick the explorer:

```bash
# View most recent transaction
TX=$(mp -f compact transaction list --wallet <addr> | jq -r '.items[0].from.txHash')
CHAIN=$(mp -f compact transaction list --wallet <addr> | jq -r '.items[0].from.chain')
# Build URL from chain → explorer table above
```

## Open a wallet

View all on-chain activity for a wallet address:

```bash
# Solana wallet
open "https://solscan.io/account/N39jn2g1tA7dmdyyoHt9yiQegQoVhnfQzq1ZzuZRF9e"

# EVM wallet (same address works on any EVM explorer)
open "https://etherscan.io/address/0xf9e39F70d7636902e57a89C18B1BE39EBb5b9589"
```

Get wallet addresses from: `mp wallet list` or `mp wallet retrieve --wallet <name>`

## Open a token page

View token contract, holders, and market data on the explorer:

```bash
# USDC on Solana
open "https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# USDC on Ethereum
open "https://etherscan.io/token/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
```

Get token addresses from: `mp token search --query "USDC" --chain solana`

## Open a checkout URL

`mp buy` returns a checkout URL. Open it directly:

```bash
URL=$(mp -f compact buy --token sol --amount 1 --wallet <addr> --email <email> | jq -r '.url')
open "$URL"
```

## Platform detection

```bash
if [[ "$OSTYPE" == "darwin"* ]]; then
  open "$URL"
else
  xdg-open "$URL"
fi
```

## Tips

- After any swap, bridge, or transfer, offer to open the result in the explorer
- EVM wallets share one address across all EVM chains — the same address works on etherscan, basescan, polygonscan, etc.
- Bitcoin uses `mempool.space` — no token pages, just transactions and addresses
- Solana signatures are base58 strings, EVM tx hashes start with `0x`

## Related skills

- **moonpay-swap-tokens** — Swap and bridge commands that produce transaction signatures
- **moonpay-buy-crypto** — Buy commands that return checkout URLs
- **moonpay-check-wallet** — Get wallet addresses to view on explorers
