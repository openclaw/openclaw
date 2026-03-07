# OpenClaw Growth Automation Platform

Event-driven automation platform for CUTMV and Full Digital funnels.

## Stack

| Layer | Tools |
|-------|-------|
| CRM / System of Record | GoHighLevel |
| DM Entry Point | ManyChat |
| Fulfillment Board | Trello |
| Payments | Stripe |
| Accounting | QuickBooks |
| Analytics | PostHog |
| Error Tracking | Sentry |
| Automation Router | n8n (optional) |

## Quick Start

```bash
# Install dependencies
make dev

# Copy and configure environment
cp .env.example .env

# Run tests
make test

# Start services
make gateway       # webhook receiver
make orchestrator  # event processor
make worker        # job executor
```

## Architecture

```
Lead Sources (Meta/Google Ads, Organic IG)
    ↓
ManyChat / Landing Pages
    ↓
webhook-gateway (FastAPI, port 8000)
    ↓ events
orchestrator (port 8001)
    ↓ jobs
worker (port 8002)
    ↓
Integrations (GHL, Trello, Stripe, Dropbox)
```

## Build Phases

- **Phase 0**: Foundation (repo, config, logging, event bus)
- **Phase 1**: Lead capture (ManyChat → GHL contact + tags)
- **Phase 2**: Booking + qualification
- **Phase 3**: Payment + fulfillment (Stripe → GHL → Trello)
- **Phase 4**: Ads experimentation engine
