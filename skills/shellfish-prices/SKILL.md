---
name: shellfish-prices
description: Price watch commands for Shellfish (add/list/remove/check).
homepage: https://shellfish.store
metadata:
  {"openclaw":{"emoji":"📉","requires":{"bins":["shellfish"]}}}
---

# shellfish-prices

Track product prices and get alerts.

Quick start

- Add watch: `shellfish watch add <lookupUrl> --target £49.99`
- List watches: `shellfish watch list`
- Remove: `shellfish watch remove 1`
- Check now: `shellfish watch check`
- Check with JSON output: `shellfish watch check --notify`

Commands

- `shellfish watch add <lookupUrl> --target <price> [--currency GBP] [--auto-buy]`
- `shellfish watch list`
- `shellfish watch remove <index|id>`
- `shellfish watch check [--notify]`

Notes

- Watches are stored at `memory/watches.json`.
- `--notify` prints JSON so Clawdbot can send alerts.
- Auto-buy will attempt checkout when target price is met.

Environment

- Requires `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` for catalog lookups.
