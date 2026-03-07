# Attribution Engine

## Overview

End-to-end campaign attribution: Meta ad → IG DM keyword → ManyChat tag → booking → Stripe → fulfillment.
Every lead carries a canonical `campaign_id` (UTM) that survives the entire funnel.

## UTM + Campaign Naming Spec

| Parameter     | Format                        | Example                        |
|---------------|-------------------------------|--------------------------------|
| `utm_source`  | `{platform}`                  | `instagram`, `facebook`        |
| `utm_medium`  | `{ad_type}`                   | `dm_ad`, `follow_ad`, `story`  |
| `utm_campaign`| `{offer}_{audience}_{month}`  | `fd_warm_mar26`                |
| `utm_content` | `{creative_variant}`          | `vsla`, `csa`                  |

Campaigns are stored lowercase, trimmed, and deduplicated.

## ManyChat Tag Schema

Tags follow `{category}:{value}` format:

| Tag                     | Meaning                              |
|-------------------------|--------------------------------------|
| `campaign:<name>`       | Which campaign sourced this lead     |
| `source:<type>`         | Channel: `ig_dm`, `fb_msg`, `web`    |
| `status:<stage>`        | Funnel stage: `new`, `qualified`, `booked`, `no_show`, `closed_won`, `closed_lost` |
| `revenue:<tier>`        | Revenue bucket: `starter`, `growth`, `scale` |

## Attribution Chain

```
Meta Ad Click
  → IG DM keyword trigger
    → ManyChat flow (tags applied)
      → GHL contact created (custom fields populated)
        → Booking created (calendar event)
          → Stripe payment (checkout or subscription)
            → Trello board provisioned (fulfillment)
```

Each step writes an `attribution_touchpoint` row:
- `touch_id`: unique identifier
- `contact_key`: canonical contact identifier
- `touch_type`: `ad_click`, `dm_keyword`, `tag_applied`, `booking_created`, `payment`, `board_provisioned`
- `source`: originating platform
- `campaign`: extracted campaign name
- `utm_json`: full UTM payload (JSON)
- `ts`: ISO timestamp

## Contact Key Strategy

`contact_key` resolves in priority order:
1. `ghl_contact_id` (preferred)
2. `manychat_subscriber_id`
3. `normalized(phone)` — E.164 format
4. `normalized(email)` — lowercase, trimmed

All identities stored in `ghl_contact_index` for cross-reference.

## Lead Attribution Model

| Field              | Description                                |
|--------------------|--------------------------------------------|
| `contact_key`      | Canonical contact identifier               |
| `first_touch_id`   | ID of earliest touchpoint                  |
| `last_touch_id`    | ID of most recent touchpoint               |
| `primary_campaign` | Deterministic: first-touch campaign wins   |
| `confidence`       | `high` (UTM present) / `medium` (tag-inferred) / `low` (manual) |
| `updated_at`       | Last recalculation timestamp               |

## Revenue Attribution

| Field              | Description                                |
|--------------------|--------------------------------------------|
| `stripe_event_id`  | Stripe event or checkout ID                |
| `contact_key`      | Canonical contact identifier               |
| `amount`           | Amount in minor units (cents)              |
| `currency`         | ISO currency code                          |
| `campaign`         | Attributed campaign (from lead_attribution)|
| `ts`               | Payment timestamp                          |

## Safety

- All writes respect `DRY_RUN` and `SAFE_MODE`
- Attribution is append-only (touchpoints never deleted)
- Revenue attribution is idempotent by `stripe_event_id`
