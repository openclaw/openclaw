---
name: blink-shopify
description: >
  Access Shopify store data: orders, products, customers, and inventory. Use when
  asked about store sales, product listings, customer data, or order fulfillment.
  Requires a linked Shopify connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "shopify" } }
---

# Blink Shopify

Access the user's linked Shopify store. Provider key: `shopify`.

## Get shop info
```bash
bash scripts/call.sh shopify /admin/api/2024-01/shop.json GET
```

## List orders
```bash
bash scripts/call.sh shopify /admin/api/2024-01/orders.json GET '{"status":"any","limit":20}'
```

## Get a specific order
```bash
bash scripts/call.sh shopify /admin/api/2024-01/orders/{order_id}.json GET
```

## List products
```bash
bash scripts/call.sh shopify /admin/api/2024-01/products.json GET '{"limit":20}'
```

## Get a product
```bash
bash scripts/call.sh shopify /admin/api/2024-01/products/{product_id}.json GET
```

## List customers
```bash
bash scripts/call.sh shopify /admin/api/2024-01/customers.json GET '{"limit":20}'
```

## Search customers
```bash
bash scripts/call.sh shopify /admin/api/2024-01/customers/search.json GET '{"query":"email:john@example.com"}'
```

## Get inventory levels
```bash
bash scripts/call.sh shopify /admin/api/2024-01/inventory_levels.json GET '{"location_ids":"{location_id}"}'
```

## Common use cases
- "How many orders did we get today?" → GET /orders.json?created_at_min=today
- "List all products in our store" → GET /products.json
- "Find customer john@example.com" → GET /customers/search.json?query=email:john@example.com
- "What's our total revenue this month?" → GET /orders.json with date filters
- "Check inventory for product X" → GET /inventory_levels.json
