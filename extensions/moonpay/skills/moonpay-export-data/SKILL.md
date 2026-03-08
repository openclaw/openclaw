---
name: moonpay-export-data
description: Export portfolio balances and transaction history to CSV or JSON files. Use for spreadsheets, tax reporting, or record-keeping.
tags: [portfolio, export]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Export data

## Goal

Save portfolio snapshots and transaction history to CSV or JSON files using `mp` output piped through `jq`. Useful for spreadsheets, tax reporting, and record-keeping.

## Prerequisites

- `jq` installed: `which jq`
- Default output directory: `~/Documents/moonpay/` (create if needed)

## Portfolio to CSV

Export all token balances for a wallet on a specific chain:

```bash
mkdir -p ~/Documents/moonpay

# Header + data
echo "symbol,name,amount,usd_value,price" > ~/Documents/moonpay/portfolio-$(date +%Y%m%d).csv

mp -f compact token balance list --wallet <address> --chain solana \
  | jq -r '.items[] | [.symbol, .name, .balance.amount, .balance.value, .balance.price] | @csv' \
  >> ~/Documents/moonpay/portfolio-$(date +%Y%m%d).csv
```

### Multi-chain portfolio

Loop over chains and append to one file:

```bash
FILE=~/Documents/moonpay/portfolio-$(date +%Y%m%d).csv
echo "chain,symbol,name,amount,usd_value,price" > "$FILE"

for CHAIN in solana ethereum base polygon arbitrum; do
  mp -f compact token balance list --wallet <address> --chain "$CHAIN" \
    | jq -r --arg chain "$CHAIN" '.items[] | [$chain, .symbol, .name, .balance.amount, .balance.value, .balance.price] | @csv' \
    >> "$FILE" 2>/dev/null
done
```

Note: EVM wallets share one address across all EVM chains. Solana uses a different address.

## Transaction history to CSV

Export swap and bridge history. These are transactions executed via the CLI and registered with swaps.xyz — not all on-chain activity.

```bash
echo "date,type,from_chain,from_token,from_amount,to_chain,to_token,to_amount,usd,status" \
  > ~/Documents/moonpay/transactions-$(date +%Y%m%d).csv

mp -f compact transaction list --wallet <address> \
  | jq -r '.items[] | [
      .transactionId,
      .type,
      .from.chain, .from.token, .from.amount,
      .to.chain, .to.token, .to.amount,
      .usd,
      .status
    ] | @csv' \
  >> ~/Documents/moonpay/transactions-$(date +%Y%m%d).csv
```

### Filter by chain

```bash
mp -f compact transaction list --wallet <address> --chain solana \
  | jq -r '.items[] | ...' >> transactions.csv
```

## Portfolio to JSON

For structured data or programmatic use:

```bash
mp -f compact token balance list --wallet <address> --chain solana \
  | jq '.items | map({symbol, amount: .balance.amount, usd: .balance.value})' \
  > ~/Documents/moonpay/portfolio-$(date +%Y%m%d).json
```

## Open exported file

After writing the file, open it in the default app:

```bash
# macOS — opens in Numbers/Excel
open ~/Documents/moonpay/portfolio-$(date +%Y%m%d).csv

# Linux
xdg-open ~/Documents/moonpay/portfolio-$(date +%Y%m%d).csv
```

## Tips

- `jq @csv` handles proper CSV escaping (quotes, commas in values)
- Date-stamp filenames to keep a history: `portfolio-20260222.csv`
- `mp transaction list` only includes CLI-executed swaps/bridges registered via swaps.xyz, not all on-chain transactions
- For a quick summary without exporting, use `mp token balance list --wallet <addr> --chain <chain>` directly
- EVM address is the same across ethereum, base, polygon, arbitrum, optimism, bnb, avalanche

## Related skills

- **moonpay-check-wallet** — View balances interactively
- **moonpay-block-explorer** — Open exported transactions in block explorers
- **moonpay-trading-automation** — Combine with scheduled exports for daily snapshots
