# CUTMV Funnel Blueprint

## Overview
Cut My Video (CUTMV) — video editing service funnel.

## Stages

```
Ad / Organic IG
    ↓
ManyChat DM (qualification flow)
    ↓
GHL Contact (tagged: brand:cutmv, source:manychat)
    ↓
Booking (GHL calendar)
    ↓
Call (show/no-show tracking)
    ↓
Offer + Checkout (Stripe link with metadata)
    ↓
Payment Confirmed → GHL WON
    ↓
Fulfillment (Trello board created)
    ↓
Delivery → Retention
```

## Key Metrics
- **CPL**: Cost per lead (DM started)
- **Cost per booked call**: Spend / booked calls
- **Show rate**: Showed / booked
- **Close rate**: Won / showed
- **CPA**: Cost per acquisition
- **LTV**: Lifetime value per client

## ManyChat Flow
1. Trigger: IG DM keyword or ad CTA
2. Qualification: ask about business type, content volume, budget
3. Tag: `brand:cutmv`, `qualified` or `unqualified`
4. Route qualified → booking link
5. Route unqualified → nurture sequence

## Offer SKUs
| Key | Description | Price |
|-----|-------------|-------|
| `cutmv_starter_500` | Starter package | $500 |
| `cutmv_growth_1000` | Growth package | $1,000 |
| `cutmv_premium_2000` | Premium package | $2,000 |

## Retention
- Monthly check-in at day 25
- Upsell trigger at delivery completion
- Referral request at 30 days
