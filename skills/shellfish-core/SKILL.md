---
name: shellfish-core
description: Core Shellfish shopping commands: search, details, cart, checkout, discover.
homepage: https://shellfish.store
metadata:
  {"openclaw":{"emoji":"🦪","requires":{"bins":["shellfish"]}}}
---

# shellfish-core

Core Shellfish CLI commands for shopping discovery and checkout.

Quick start

- `shellfish search "running shoes" --limit 5 --ships-to GB --currency GBP`
- `shellfish details <lookupUrl>`
- `shellfish cart add <checkoutUrl|variantId> --qty 1 --shop <domain>`
- `shellfish checkout <checkoutUrl> --mode handoff`
- `shellfish discover <domain>`

Search

- Basic: `shellfish search "gymshark vest" --limit 5`
- Direct store (no auth): `shellfish search "wool runners" --store allbirds.com`
- Cards JSON: `shellfish search "headphones" --format cards --output json`
- With context: `shellfish search "running shoes" --context "UK buyer under £120"`

Details

- `shellfish details <lookupUrl> [--ships-to GB] [--shop-id <id>] [--variant-id <id>]`

Cart

- Add: `shellfish cart add <checkoutUrl|variantId> [--qty N] [--title text] [--price N] [--currency CODE] [--shop domain]`
- Show: `shellfish cart show`
- Remove: `shellfish cart remove <index>`
- Checkout URLs: `shellfish cart checkout`

Checkout

- Handoff: `shellfish checkout <checkoutUrl> --mode handoff`
- Browser steps: `shellfish checkout <checkoutUrl> --mode browser`
- Shop Pay: `shellfish checkout <checkoutUrl> --mode shoppay`
- Shop Pay QR: `shellfish checkout <checkoutUrl> --mode shoppay-qr`
- MCP checkout: `shellfish checkout <checkoutUrl> --mode mcp`

Discovery

- `shellfish discover <domain>`

Notes

- `--store <domain>` uses Storefront MCP and does not require Shopify API keys.
- Preferences are loaded from `memory/preferences.json` when available.

Environment

Required for catalog search (non-Storefront MCP):
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

Optional for browser checkout:
- `SHELLFISH_SHIPPING_*` (address fields)
- `SHELLFISH_PAYMENT_TYPE` (`shop_pay` | `card` | `auto`)
- `SHELLFISH_CARD_*`
