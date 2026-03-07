# Momentum Campaign

## Overview

Time-boxed follow-up blitz targeting warm audiences for quick cashflow wins in 1–2 weeks.
Systematic reactivation of past leads, no-shows, past clients, and upsell-eligible contacts.

## Warm Audience Definition

| Segment          | Criteria                                              |
|------------------|-------------------------------------------------------|
| Past leads       | Status: `qualified` or `no_show`, last touch < 90 days|
| No-shows         | Status: `no_show`, booking in last 60 days            |
| Past clients     | Status: `closed_won`, fulfillment completed           |
| Upsell eligible  | Active clients on lower-tier offer                    |

Segments are built from `ghl_contact_index` + `lead_attribution` + ManyChat tags.

## 7–14 Day Sprint Logic

A momentum campaign is defined by:

| Field              | Description                                    |
|--------------------|------------------------------------------------|
| `campaign_id`      | Unique campaign identifier                     |
| `name`             | Human-readable name                            |
| `start_date`       | Sprint start date                              |
| `end_date`         | Sprint end date (7–14 days from start)         |
| `segments`         | List of warm audience segments to target        |
| `cadence`          | Touches per week (2–4)                         |
| `channels`         | Ordered list: `dm`, `sms`, `email`             |
| `status`           | `draft`, `active`, `paused`, `completed`       |

## Messaging Templates

Each touch follows the "give give give ask" framework:

| Touch # | Type           | Template                                    |
|---------|----------------|---------------------------------------------|
| 1       | Re-engage      | Acknowledge gap + share new result           |
| 2       | Value drop     | Case study or free resource                  |
| 3       | Soft ask       | "Curious if timing is better now?"           |
| 4       | Direct CTA     | Clear offer + booking link                   |

Templates are parameterized by segment and offer tier.

## Stop Rules

A contact is removed from the sprint if:
- They book a call → transition to pre-call nurture
- They reply "not interested" or opt out
- They close (won or lost)
- Max touches reached for this sprint (default: 4)
- Global cooldown is active
- Contact was touched by another campaign in last 48h

## Anti-Spam Protections

- Max 1 DM per contact per 24 hours
- Max 4 total touches per contact per sprint
- Respect platform-specific rate limits (ManyChat, GHL)
- Global cooldown integration
- JobGuard budget enforcement on batch processing

## Audit Trail

Every momentum action is logged:
- `scheduled_actions` table for pending touches
- `audit_log` for executed/simulated actions
- `job_runs` for batch execution telemetry

## Safety

- Campaign defaults to `draft` status — must be explicitly activated
- All touches are simulated in `DRY_RUN` / `SAFE_MODE`
- No automated sends without campaign activation
- Sprint auto-pauses if error rate exceeds threshold
