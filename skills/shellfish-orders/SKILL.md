---
name: shellfish-orders
description: Purchase ledger commands for Shellfish (orders list/add/show/update).
homepage: https://shellfish.store
metadata:
  {"openclaw":{"emoji":"🧾","requires":{"bins":["shellfish"]}}}
---

# shellfish-orders

Manage the local purchase ledger (memory/purchases.json).

Quick start

- List: `shellfish orders list`
- Add: `shellfish orders add --merchant allbirds.com --item "Tree Runner" --price 99.00 --currency GBP`
- Show: `shellfish orders show <orderId>`
- Update: `shellfish orders update <orderId> --status shipped --tracking RM123 --carrier "Royal Mail"`

Commands

- `shellfish orders list [--status <status>] [--merchant <domain>] [--since <YYYY-MM-DD>] [--limit N] [--json]`
- `shellfish orders add --merchant <domain> --item <title> --price <amount> [--currency GBP] [--qty N] [--order-id id]`
- `shellfish orders show <orderId>`
- `shellfish orders update <orderId> [--status <status>] [--tracking <num>] [--carrier <name>]`

Statuses

- `pending`, `confirmed`, `shipped`, `delivered`, `returned`, `cancelled`

Notes

- Orders are stored at `memory/purchases.json`.
- MCP checkouts auto-record orders when an order ID is returned.
