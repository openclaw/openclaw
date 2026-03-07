# Offer Productization

## Overview

Offers are outcome-driven, repeatable, and delegatable.
Each offer tier maps to a Stripe Price ID and a defined scope of fulfillment deliverables.

## Offer Definition Framework

An offer must satisfy three criteria:
1. **Outcome-driven**: Defined by the result the client gets, not hours worked
2. **Repeatable**: Same process, same deliverables, predictable timeline
3. **Delegatable**: Can be fulfilled by a trained team member, not just the founder

## Offer Tiers

| Tier           | Name              | Price    | Stripe Price ID Config Key          | Deliverables                     |
|----------------|-------------------|----------|-------------------------------------|----------------------------------|
| Rollout        | FD Rollout        | $800     | `STRIPE_PRICE_ID_FD_ROLLOUT_800`   | Brand kit + 4 posts + setup      |
| Subscription   | FD Monthly        | $1,500/mo| `STRIPE_PRICE_ID_FD_SUB_1500`      | 12 posts/mo + stories + management|
| Pro            | CUTMV Pro         | Custom   | `STRIPE_PRICE_ID_CUTMV_PRO`        | Full video production package    |

## Mapping to Fulfillment

Each offer tier maps to:
- A Trello board template (lists, reference cards, checklists)
- A set of deliverable types (defined in `deliverables_checklist.py`)
- A timeline (due dates auto-set on board creation)
- Assignment rules (which team roles are needed)

## Stripe Integration

- Checkout sessions created with `offer_intent` metadata
- Price ID resolved from config at checkout time
- Revenue attribution links payment to originating campaign
- Subscription lifecycle (active, cancelled, past_due) tracked

## Upsell / Cross-sell Matrix

| Current Offer  | Upsell Target        | Trigger                           |
|----------------|----------------------|-----------------------------------|
| Rollout        | FD Monthly           | 30 days post-delivery             |
| FD Monthly     | CUTMV Pro add-on     | 90 days active + positive feedback|
| CUTMV Pro      | Retainer increase    | Capacity available + results proof|

Upsell eligibility is a segment in the Momentum Campaign system.

## Safety

- Price IDs are config-driven, never hardcoded
- Checkout always requires explicit user action
- No automated upsell charges — system surfaces recommendations only
