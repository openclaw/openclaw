# GoHighLevel Setup Guide

## Pipelines

### CUTMV Pipeline
| Stage | Internal Name | Triggers |
|-------|--------------|----------|
| New Lead | `new` | Contact created from ManyChat/ads |
| Qualified | `qualified` | DM qualification passed |
| Booked | `booked` | Calendar appointment created |
| Showed | `showed` | Manual or auto (Zoom attendance) |
| Won | `won` | Stripe payment confirmed |
| Lost | `lost` | Manual or 30-day no-action |
| Onboarding | `onboarding` | Trello board created |
| In Progress | `in_progress` | Trello card moved to In Progress |
| Delivered | `delivered` | Trello card moved to Published/Delivered |

### Full Digital Pipeline
Same stages as CUTMV (separate pipeline for reporting).

## Core Tags
| Tag | Purpose |
|-----|---------|
| `brand:cutmv` | CUTMV funnel contact |
| `brand:fulldigital` | Full Digital funnel contact |
| `source:manychat` | Came via ManyChat DM |
| `source:ads` | Came via paid ads |
| `source:organic` | Came via organic traffic |
| `qualified` | Passed qualification |
| `booked_call` | Has a booked call |
| `paid` | Payment received |
| `won` | Deal closed |
| `fulfillment_started` | Trello board created |

## Workflows (GHL Automations)
1. **Speed-to-lead**: Contact created → SMS within 5 min
2. **Booking reminder**: 24h + 1h before appointment
3. **No-show follow-up**: If no show → SMS + email 30 min after
4. **Post-call follow-up**: After call → checkout link if qualified
5. **Payment confirmation**: Stripe paid → thank you SMS + email
6. **Fulfillment updates**: Stage changes → appropriate notifications

## Custom Fields
| Field | Type | Description |
|-------|------|-------------|
| `ig_handle` | Text | Instagram username |
| `manychat_id` | Text | ManyChat subscriber ID |
| `brand` | Dropdown | cutmv / fulldigital |
| `offer_key` | Text | Selected offer SKU |
| `trello_board_url` | Text | Link to fulfillment board |
