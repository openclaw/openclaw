# Event Schema

All automation flows communicate via structured events. Every event has:

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | string | Unique event ID (e.g., `evt_a1b2c3d4`) |
| `name` | string | Event name (dot-delimited) |
| `ts` | datetime | UTC timestamp |
| `brand` | string? | `cutmv` or `fulldigital` |
| `correlation_id` | string? | Links related events across services |
| `payload` | object | Event-specific data |

## Standard Event Names

### Lead Funnel
| Event | Trigger |
|-------|---------|
| `lead.captured` | ManyChat webhook or GHL contact created |
| `lead.qualified` | Contact enriched + tags applied |
| `lead.updated` | Contact data changed |

### Booking
| Event | Trigger |
|-------|---------|
| `booking.created` | Calendar booking confirmed |
| `booking.showed` | Attendee marked as showed |

### Payment
| Event | Trigger |
|-------|---------|
| `payment.pending` | Checkout session created |
| `payment.paid` | Stripe checkout completed |
| `payment.failed` | Payment failed or expired |

### Deal
| Event | Trigger |
|-------|---------|
| `deal.won` | Payment confirmed → triggers fulfillment |
| `deal.lost` | Opportunity marked lost |

### Fulfillment
| Event | Trigger |
|-------|---------|
| `fulfillment.created` | Trello board created |
| `fulfillment.assigned` | Designer assigned |
| `fulfillment.in_progress` | Work started |
| `fulfillment.needs_review` | Card moved to Needs Review |
| `fulfillment.delivered` | Card moved to Published/Delivered |

### Trello
| Event | Trigger |
|-------|---------|
| `trello.card.moved` | Card moved between lists |
| `trello.card.created` | New card created |

### Ads
| Event | Trigger |
|-------|---------|
| `ads.experiment.started` | Experiment launched |
| `ads.experiment.paused` | Experiment paused |
| `ads.experiment.completed` | Experiment finished |
| `ads.metrics.daily` | Daily metrics pulled |
| `ads.proposals.generated` | AI decisions emitted |

### Creative
| Event | Trigger |
|-------|---------|
| `creative.generated` | Script/spec created |
| `creative.rendered` | Video/image rendered |
| `creative.packaged` | Assets zipped and uploaded |

## UTM Parameters

All ad traffic should use consistent UTMs:

```
utm_source=meta|google|organic
utm_medium=paid|organic|dm
utm_campaign={campaign_name}
utm_content={creative_id}
utm_term={keyword_or_audience}
```

## Attribution

- `contact_id` links everything to a person
- `creative_id` links to the ad creative that drove the lead
- `experiment_id` links to the test batch
- `correlation_id` links events within a single workflow run
