---
name: moonpay-commerce
description: Browse Shopify stores, search products, manage a cart, and checkout with crypto via Solana Pay. No login required.
tags: [commerce, shopping]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Shop with crypto

## Goal

Browse Solana Pay-enabled Shopify stores, add items to a cart, and pay with crypto. The entire flow runs from the CLI — no browser needed.

## Commands

### List stores

```bash
mp commerce store list
```

### Search products

```bash
mp commerce product search --store <store> --query <search-term>
```

### Get product details

```bash
mp commerce product retrieve --store <store> --productId <product-id>
```

### Add item to cart

```bash
mp commerce cart add \
  --store <store> \
  --variantId <variant-id> \
  --quantity <number> \
  --cartId <cart-id>  # omit to create a new cart
```

### View cart

```bash
mp commerce cart retrieve --store <store> --cartId <cart-id>
```

### Remove item from cart

```bash
mp commerce cart remove --store <store> --cartId <cart-id> --lineId <line-id>
```

### Checkout and pay

```bash
mp commerce checkout \
  --wallet <wallet-name> \
  --store <store> \
  --cartId <cart-id> \
  --chain solana \
  --email <buyer-email> \
  --firstName <first> \
  --lastName <last> \
  --address <street-address> \
  --city <city> \
  --postalCode <zip> \
  --country <country-name>
```

## Example flow

1. Browse stores: `mp commerce store list`
2. Search: `mp commerce product search --store ryder.id --query "ryder"`
3. Add to cart: `mp commerce cart add --store ryder.id --variantId "gid://shopify/ProductVariant/51751218774319" --quantity 1`
4. Check cart: `mp commerce cart retrieve --store ryder.id --cartId <id-from-step-3>`
5. Checkout: `mp commerce checkout --wallet main --store ryder.id --cartId <id> --chain solana --email buyer@example.com --firstName John --lastName Doe --address "123 Main St" --city Amsterdam --postalCode 1011 --country Netherlands`

## How it works

1. Stores expose a Shopify MCP endpoint for browsing and cart management
2. `cart add` creates or updates a cart (no auth needed, cart ID is the handle)
3. `checkout` calls the API to start a Helio payment, signs the transaction locally, and submits
4. Helio pays gas — the buyer only pays the item price in USDC
5. Returns a transaction signature and order confirmation URL

## Tips

- Run `cart add` multiple times to add different items — pass the `--cartId` from the first call
- Use `product search` to find variant IDs — each variant has a Shopify GID
- The `--country` flag takes full country names (e.g. "United States", "Netherlands")
- Checkout takes 30-90 seconds — the API automates the Shopify checkout flow
- Currently supports Solana chain only for payment

## Related skills

- **moonpay-auth** — Set up a local wallet for signing
- **moonpay-check-wallet** — Check USDC balance before checkout
- **moonpay-swap-tokens** — Swap tokens to get USDC for payment
