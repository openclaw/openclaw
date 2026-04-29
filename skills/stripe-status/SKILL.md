---
name: stripe-status
description: "Check Stripe payments, subscriptions, refunds, balances, and listen to webhooks using the Stripe CLI."
homepage: https://docs.stripe.com/stripe-cli
metadata:
  {
    "openclaw":
      {
        "emoji": "💳",
        "requires": { "bins": ["stripe"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "stripe/stripe-cli/stripe",
              "bins": ["stripe"],
              "label": "Install Stripe CLI (brew)",
            },
          ],
      },
  }
---

# Stripe Status Skill

Query Stripe account data, check payment status, and debug webhooks from the terminal.

## When to Use

✅ **USE this skill when:**

- "Check my recent payments"
- "Show failed charges"
- "List subscriptions"
- "What's my Stripe balance?"
- "Show recent refunds"
- "Listen for webhooks"
- "Tail the API logs"
- "Look up a customer"
- "Check a payment intent"
- Debugging payment flows or webhook delivery

## When NOT to Use

❌ **DON'T use this skill when:**

- Creating complex Stripe integrations → use the Stripe SDK
- Building checkout flows → use Stripe Docs
- PCI compliance questions → consult Stripe's compliance guides
- Accounting or tax reports → use the Stripe Dashboard or exports
- Modifying product/price catalog at scale → use the Dashboard or API directly

## Prerequisites

The user must be logged in: `stripe login`. The CLI uses the authenticated account for all commands.

## Commands

### Account & Balance

```bash
# Check which account is active
stripe config --list

# Current balance (available + pending)
stripe balance retrieve

# Recent balance transactions
stripe balance_transactions list --limit 10
```

### Payments

```bash
# Recent successful payments
stripe payment_intents list --limit 10 --status succeeded

# Failed payments only
stripe payment_intents list --limit 10 --status requires_payment_method

# Look up a specific payment
stripe payment_intents retrieve pi_xxx

# Recent charges with amount details
stripe charges list --limit 10
```

### Subscriptions

```bash
# Active subscriptions
stripe subscriptions list --limit 10 --status active

# Past due (failed payment)
stripe subscriptions list --limit 10 --status past_due

# Canceled subscriptions
stripe subscriptions list --limit 10 --status canceled

# Look up a specific subscription
stripe subscriptions retrieve sub_xxx
```

### Refunds

```bash
# Recent refunds
stripe refunds list --limit 10

# Look up a specific refund
stripe refunds retrieve re_xxx
```

### Customers

```bash
# Recent customers
stripe customers list --limit 10

# Search by email
stripe customers list --email customer@example.com

# Look up a specific customer
stripe customers retrieve cus_xxx
```

### Webhooks & Debugging

```bash
# Listen for all webhook events (forwards to local server)
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# Listen for specific events only
stripe listen --events checkout.session.completed,payment_intent.succeeded

# Trigger a test event
stripe trigger payment_intent.succeeded

# View recent API request logs
stripe logs tail
```

### Events

```bash
# Recent events
stripe events list --limit 10

# Filter by event type
stripe events list --type payment_intent.succeeded --limit 5

# Look up a specific event
stripe events retrieve evt_xxx
```

## Quick Responses

**"Are payments working?"**

```bash
stripe charges list --limit 5
```

Check the status field — `succeeded` means payments are processing normally.

**"Any failed payments?"**

```bash
stripe payment_intents list --limit 10 --status requires_payment_method
```

**"What's my balance?"**

```bash
stripe balance retrieve
```

**"Debug webhooks locally"**

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

## Notes

- Requires `stripe login` before first use
- All commands hit the Stripe API — respect rate limits
- Use `--limit` to control result count (default varies by resource)
- Add `--stripe-account acct_xxx` to query connected accounts
- Use test mode key (`sk_test_`) during development
- The CLI auto-detects test vs live mode from your config
