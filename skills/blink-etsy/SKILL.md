---
name: blink-etsy
description: >
  Access Etsy shop listings, orders, and shop data. Use when asked about Etsy
  sales, product listings, or shop analytics. Requires a linked Etsy connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "etsy" } }
---

# Blink Etsy

Access the user's linked Etsy shop. Provider key: `etsy`.

## Get my user info
```bash
bash scripts/call.sh /application/users/me GET
```

## Get my shops
```bash
bash scripts/call.sh /application/users/me/shops GET
```

## List shop listings (active)
```bash
bash scripts/call.sh /application/shops/{shopId}/listings GET '{"state":"active","limit":20}'
```

## Get a specific listing
```bash
bash scripts/call.sh /application/listings/{listingId} GET
```

## Get shop receipts (orders)
```bash
bash scripts/call.sh /application/shops/{shopId}/receipts GET '{"limit":20}'
```

## Get a specific order
```bash
bash scripts/call.sh /application/shops/{shopId}/receipts/{receiptId} GET
```

## Get shop stats
```bash
bash scripts/call.sh /application/shops/{shopId}/stats GET
```

## List shop reviews
```bash
bash scripts/call.sh /application/shops/{shopId}/reviews GET '{"limit":10}'
```

## Common use cases
- "How many active listings do I have on Etsy?" → GET /shops/{id}/listings?state=active
- "Show my recent Etsy orders" → GET /shops/{id}/receipts
- "What are my shop's stats?" → GET /shops/{id}/stats
- "List all products in my Etsy shop" → GET /shops/{id}/listings
- "Check reviews for my shop" → GET /shops/{id}/reviews
