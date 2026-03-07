# CUTMV Revenue and Billing Notes

> Complete documentation of the monetization system: subscriptions, credits, referrals, and promo codes.
> Package location: `packages/cutmv-app/`

---

## 1. Revenue Streams

CUTMV has three revenue streams:

1. **Monthly subscriptions** (Stripe recurring) — predictable revenue
2. **Credit purchases** (Stripe one-time) — usage-based revenue
3. **Referral program** — growth engine (cost center, not revenue)

---

## 2. Subscription Plans

Source: `server/services/subscription-service.ts`

| Plan | Monthly Price | Monthly Credits | Bulk Download | Key Benefit |
|------|---------------|-----------------|---------------|-------------|
| Starter | $10 | 1,000 | No | 50% off all processing |
| Pro | $25 | 3,000 | Yes (ZIP) | 50% off + bulk download |
| Enterprise | $75 | 10,000 | Yes (ZIP) | 50% off + bulk + priority support |

### Subscription Mechanics

- **Credit reset**: Monthly credits reset on billing cycle date (stored in `subscription_credit_reset_date`)
- **Credit priority**: Subscription credits consumed first, then purchased credits
- **Cancellation**: Takes effect at end of billing period (Stripe `at_period_end`)
- **Reactivation**: Can reactivate before period ends
- **Payment failure**: 5 consecutive failures auto-cancels subscription
- **Stripe price IDs**: `STRIPE_STARTER_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, `STRIPE_ENTERPRISE_PRICE_ID`

### Subscriber Benefits

All subscribers get:
- **50% discount** on all processing costs (via `NON_SUBSCRIBER_MULTIPLIER: 2`)
- Monthly credit allocation (resets each cycle)
- Can still purchase additional credits (permanent, no expiry)

---

## 3. Credit System

Source: `server/services/credit-service.ts`

### Credit Costs Per Operation

| Operation | Subscriber Rate | Non-Subscriber Rate |
|-----------|----------------|---------------------|
| Cutdown (per clip x aspect ratio) | 50 credits | 100 credits |
| GIF Pack | 90 credits | 180 credits |
| Thumbnail Pack | 90 credits | 180 credits |
| Canvas Pack (Spotify) | 225 credits | 450 credits |

### Two-Tier Credit Pool

Users have two separate credit balances:

1. **Subscription credits** (`subscriptionCredits` column) — Monthly allowance, resets each billing cycle
2. **Purchased credits** (`credits` column) — Never expire, purchased separately

Processing logic: deduct from subscription credits first, then purchased credits.

### Credit-to-Dollar Conversion

Base rate: **$1 = 100 credits**

### Credit Purchase Packages

Source: `server/credit-routes.ts`

| Package | Price | Credits | Bonus |
|---------|-------|---------|-------|
| Small | $5 | 500 | None |
| Medium | $10 | 1,000 | None |
| Large | $25 | 3,000 | +20% bonus (2,500 base + 500 extra) |

### Credit Transaction Types

Source: `shared/schema.ts`

| Type | Description |
|------|-------------|
| `referral_signup` | +1 credit for successful referral |
| `first_export_bonus` | +1 credit when referred user exports |
| `export_usage` | Credits deducted for processing |
| `subscription_monthly` | Monthly subscription allocation |
| `subscription_bonus` | Promotional credits |
| `credit_purchase` | Customer-purchased credits |
| `admin_grant` | Manual admin grants |
| `expiration` | Expired referral credits (60-day expiry) |

---

## 4. Pricing Calculation

Source: `server/routes.ts` (`/api/calculate-price` endpoint)

### Example Cost Calculation

**Scenario**: 5 timestamps, 2 aspect ratios (16:9 + 9:16), all export types

| Export Type | Count | Subscriber Cost | Non-Subscriber Cost |
|-------------|-------|----------------|---------------------|
| Cutdowns | 5 timestamps x 2 ratios = 10 | 10 x 50 = 500 | 10 x 100 = 1,000 |
| GIF Pack | 1 | 90 | 180 |
| Thumbnail Pack | 1 | 90 | 180 |
| Canvas Pack | 1 | 225 | 450 |
| **Total** | | **905 credits** | **1,810 credits** |

### Price Response Format

```json
{
  "totalAmount": 905,
  "originalAmount": 1810,
  "isSubscriber": true,
  "subscriberCost": 905,
  "nonSubscriberCost": 1810,
  "potentialSavings": 905,
  "breakdown": {
    "cutdowns": { "count": 10, "cost": 500 },
    "gifs": { "count": 1, "cost": 90 },
    "thumbnails": { "count": 1, "cost": 90 },
    "canvas": { "count": 1, "cost": 225 }
  }
}
```

---

## 5. Payment Flow

### Credit-Based Processing Flow

1. User selects processing options (timestamps, aspect ratios, exports)
2. Frontend calls `POST /api/calculate-price` to display cost
3. User clicks "Process" -> `POST /api/create-payment-session`
4. Server checks credit balance (subscription + purchased)
5. **If sufficient credits**: deducts immediately, starts background job
6. **If insufficient**: returns 402 with shortfall amount and purchase prompt

### Credit Purchase Flow

1. User selects credit package
2. `POST /api/credits/purchase` creates Stripe Checkout session
3. User redirected to Stripe Checkout
4. On success: Stripe fires `checkout.session.completed` webhook
5. Webhook handler credits user account

### Subscription Flow

1. User selects plan on `/subscription` page
2. `POST /api/subscription/create-checkout` creates Stripe Checkout session
3. On success: `customer.subscription.created` webhook grants initial credits
4. Monthly: `invoice.payment_succeeded` webhook renews credits

---

## 6. Stripe Integration

Source: `server/stripe-webhook.ts`

### Webhook Events Handled

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Process credit purchase or new subscription |
| `customer.subscription.created` | Grant initial subscription credits |
| `invoice.payment_succeeded` | Clear failure counter, grant monthly renewal |
| `invoice.payment_failed` | Increment failure counter, send reminder |
| `customer.subscription.deleted` | Clear subscription and credits |
| `customer.subscription.updated` | Log plan changes |

### Stripe Config

- API version: `2025-07-30.basil`
- Webhook signature verification via `STRIPE_WEBHOOK_SECRET`
- Customer auto-creation with test-to-live migration handling
- Raw body parsing required (middleware registered before JSON parser)

---

## 7. Promo Code System

Source: `server/services/promoCodeService.ts`

### Known Promo Codes

| Code | Type | Discount | Expiry | Usage Limit | Per-User Limit | Notes |
|------|------|----------|--------|-------------|----------------|-------|
| STAFF25 | Percentage | 100% off | 2025-12-31 | 1,000 | 10 | Staff/testing code |
| MORE20 | Percentage | 20% off | None | None | None | General promo |
| GET15 | Percentage | 15% off | None | None | None | General promo |
| LAUNCH25 | Percentage | 25% off | None | None | None | Launch promo |

### Promo Code Features

- Global usage limits and per-email tracking
- Validated before payment via `POST /api/validate-promo-code`
- Applied at checkout before credit deduction
- In-memory storage (not persisted to database — needs migration)

### Security Note

STAFF25 grants 100% discount and expired 2025-12-31. Should be removed or updated.

---

## 8. Referral Program

Source: `server/services/referral-service.ts`

### Referral Rewards

| Event | Referrer Reward | Referred User Reward |
|-------|----------------|---------------------|
| Successful signup | +1 credit | Welcome bonus eligible |
| First export by referred user | +1 credit | N/A |
| Every 5 successful referrals | +1 milestone bonus | N/A |

### Referral Mechanics

- **Referral URL format**: `https://cutmv.fulldigitalll.com/referral/{CODE}`
- **Code format**: 8-character alphanumeric (nanoid), customizable 3-15 chars
- **Credit expiry**: Referral credits expire after 60 days if unused
- **Rate limit**: Max 5 referral credits per week per referrer
- **Database tracking**: `referral_events` + `referral_tracking` tables

### Anti-Fraud Measures

- Duplicate session blocking (1 referral per session)
- IP-based duplicate prevention (24-hour cooldown)
- Self-referral prevention
- SHA256 IP hashing for privacy
- Rate limiting (5 credits/week/referrer)

---

## 9. Free Tier

There is no explicit free tier. Non-subscribers can use the service by purchasing credits, but they pay 2x the subscriber rate for all operations.

| Aspect | Free/Non-Subscriber | Subscriber |
|--------|---------------------|------------|
| Processing cost | 2x base rate | 1x base rate |
| Monthly credits | None | 1,000-10,000 |
| Credit purchases | Available | Available |
| Bulk download | No | Pro/Enterprise only |
| Referral credits | Earn, expire in 60 days | Earn, expire in 60 days |

---

## 10. Annual Revenue Potential Per Subscriber

| Plan | Annual Revenue | Annual Credits Granted | Credit Value |
|------|---------------|----------------------|--------------|
| Starter | $120/year | 12,000 credits | ~$120 at $1/100cr |
| Pro | $300/year | 36,000 credits | ~$360 at $1/100cr |
| Enterprise | $900/year | 120,000 credits | ~$1,200 at $1/100cr |

Pro and Enterprise provide more credits per dollar than direct purchase, incentivizing subscription.

---

## 11. Environment Variables (Billing)

| Variable | Purpose |
|----------|---------|
| `STRIPE_SECRET_KEY` | Stripe API authentication |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `STRIPE_STARTER_PRICE_ID` | Starter plan Stripe price ID |
| `STRIPE_PRO_PRICE_ID` | Pro plan Stripe price ID |
| `STRIPE_ENTERPRISE_PRICE_ID` | Enterprise plan Stripe price ID |
| `CUSTOM_DOMAIN` / `DOMAIN` | For referral URL generation |

---

## 12. Known Issues and Opportunities

### Issues
1. **STAFF25 expired** — 100% discount code expired 2025-12-31, should be removed
2. **Promo codes in-memory** — Not persisted to database; restart loses usage tracking
3. **No refund system** — No automated refund handling
4. **No plan upgrade/downgrade** — Subscription changes not fully implemented
5. **No trial period** — No free trial offered
6. **USD only** — No multi-currency support

### Opportunities
1. **Dynamic pricing** — Move credit costs to database for A/B testing
2. **Usage analytics** — Add revenue dashboards and churn tracking
3. **Team billing** — Organization-level subscriptions
4. **Annual plans** — Discount for annual commitment
5. **Overage billing** — Auto-purchase credits when subscription runs out
