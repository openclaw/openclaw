---

## name: blink-stripe
description: >
  Access Stripe Connect data: customers, subscriptions, invoices, charges, and
  payouts. Use when asked to check revenue, look up customers, or manage billing.
  Requires a linked Stripe connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "stripe" } }

# Blink Stripe

Access the user's linked Stripe account. Provider key: `stripe` or `composio_stripe` (check `blink connector status` for the exact key).

## Get account balance

```bash
blink connector exec stripe /balance GET
```

## List customers

```bash
blink connector exec stripe /customers GET '{"limit":20}'
```

## Get a specific customer

```bash
blink connector exec stripe /customers/{id} GET
```

## List recent charges

```bash
blink connector exec stripe /charges GET '{"limit":10}'
```

## List subscriptions

```bash
blink connector exec stripe /subscriptions GET '{"status":"active","limit":20}'
```

## Get a subscription

```bash
blink connector exec stripe /subscriptions/{id} GET
```

## List invoices

```bash
blink connector exec stripe /invoices GET '{"limit":10}'
```

## List payouts

```bash
blink connector exec stripe /payouts GET '{"limit":10}'
```

## Common use cases

- "What's my current Stripe balance?" → GET /balance
- "Find customer [john@example.com](mailto:john@example.com)" → GET /customers?email=[john@example.com](mailto:john@example.com)
- "Show recent payments" → GET /charges
- "List all active subscriptions" → GET /subscriptions?status=active
- "Check MRR or revenue data" → GET /charges with date filters

