# OpenClaw Capabilities — CUTMV & Full Digital

## Overview

OpenClaw is a **strategic operating system** for both brands — an autonomous
operations layer run by DA (Don Anthony Tyson Jr.) on a 3-node local cluster.
It functions as a research assistant, automation operator, decision support
engine, workflow orchestrator, opportunity scout, memory system, and product
growth engine.

---

## Cluster Architecture

| Node | Role | Duties |
|------|------|--------|
| **M4 Mac Mini** (Brain) | Gateway, orchestrator, webhook receiver | Agent routing, planning, inference, coordination |
| **M1 Mac Studio** (Workhorse) | Ollama inference, worker | Research, ad creative gen, landing pages, long-running growth jobs |
| **i7 MacBook Pro** (Sentinel) | Cron, monitoring | Watchdog, alerting, backup agent, failover |

Local inference via **Ollama (Qwen 3.5)** with **Claude (Anthropic)** as
escalation for complex analysis.

---

## AI Agents (7 Total, Brand-Routed)

### Full Digital LLC (4 Agents)

- **`fulldigital-ops`** — Daily status summaries, approval routing, cluster
  health, internal command center
- **`fulldigital-sales`** — Lead follow-up, outreach drafting, proposals
  (Rollout Package $800, Monthly Retainer $1,500, CUTMV Pro)
- **`fulldigital-content`** — Caption writing, hook generation, content
  calendar planning, campaign concepts
- **`fulldigital-finance`** — Grant scanning, bookkeeping, financial reporting

### CUTMV (3 Agents)

- **`cutmv-ops`** — Product roadmap, bug triage, infrastructure, deployment
- **`cutmv-support`** — Customer help, FAQs, onboarding assistance for
  artists and labels
- **`cutmv-growth`** — Promotional campaigns, announcements, conversion
  messaging

Intent classification routes messages to the right agent automatically based
on brand + domain (e.g., "grant" routes to `fulldigital-finance`, "bug" routes
to `cutmv-ops`).

---

## Full Digital Capabilities

### Revenue Automation

- Automated lead research and qualification
- Proposal generation and follow-up sequences
- Pipeline health tracking — flags stale deals
- **Retainer conversion funnel** — auto-detects candidates ($5K+ spend, 2+
  projects) and queues "Era Control Retainer" ($6K/mo) or "90-Day Growth Pack"
  ($4K/mo) outreach sequences
- **VSL optimization** — tracks hook variants, retention scoring, conversion
  diagnostics, auto-recommends rewrites when hooks underperform

### Marketing and Content

- Caption writing, hook generation, content calendar planning
- Ad creative generation and rotation
- VSL variant A/B testing with retention and conversion scoring
- Blog watching and trend monitoring

### Finance

- Daily grant scanning for Atlanta-based opportunities
- Grant scoring, draft packages, submission support
- Bookkeeping integration and financial reporting

### Client Operations

- GoHighLevel CRM integration (pipeline, client comms)
- Trello project management (fulfillment boards)
- Stripe payments and invoicing
- ManyChat lead capture and automated messaging

### Site

fulldigitalll.com (Webflow + Cloudflare), tracked via GA4 + PostHog.

---

## CUTMV Capabilities

### Product Ops

- Bug triage summaries and code fixes
- Feature prioritization and shipping
- Roadmap management and infrastructure monitoring
- Remotion-based video rendering engine (React video components)

### Growth Engine

- Marketing copy, landing page creation, A/B testing
- Ad concept generation (60+ motion specs, premium ad templates)
- Pricing and conversion optimization
- Funnel and retention improvement campaigns
- Promotional campaign drafting and announcements

### Customer Support

- Onboarding assistance for independent artists, small labels, media teams
- Troubleshooting and FAQ handling
- User activation guidance (first render to conversion)

### Product Stack

cutmv.com (Vercel + Cloudflare), with Stripe (subscriptions + per-render),
Supabase, R2 storage, PostHog analytics, Sentry error tracking, Resend email,
Kickbox verification, Google/Microsoft OAuth.

### Creative Engine

Full Remotion pipeline with branded motion specs, ad templates
(`CutmvPremiumAd`, `CutmvAdEngine`), UI frames, dashboard mocks, and brand
asset policies for both `cutmv` and `fulldigital` logos and overlays.

---

## Cross-Brand Automation

### Event-Driven Architecture

- Webhook gateway (port 8000) receives events from GHL, ManyChat, Stripe,
  Trello
- Orchestrator (port 8001) consumes events, routes decisions, schedules jobs
- Worker (port 8002) executes creative generation, rendering, packaging
- Every event tracked to PostHog with correlation IDs

### Safety Controls (Non-Negotiable)

- `DRY_RUN=true` by default — all writes simulated
- `KILL_SWITCH` — blocks ALL external writes instantly
- Human approval required for: sending outreach, launching campaigns, spending
  money, publishing content, submitting grants, creating invoices
- Idempotency store prevents duplicate webhook processing
- Full audit trail on every external mutation

### Memory and Knowledge

- Persistent memory across sessions — client preferences, project outcomes,
  lessons learned
- Brand profiles, entity databases, opinions and strategy bank
- Gets smarter over time — tracks what worked and what failed

### Channels

Telegram (primary control), Command Center UI (dashboard), Notion (knowledge),
API (programmatic).

### Cron and Scheduling

Daily grant scans, pipeline health checks, cluster monitoring, watchdog
alerts, scheduled campaign tasks.

---

## Strategic Summary

At full functionality, OpenClaw enables a one-person operation that runs like
a team across both brands:

- **Full Digital** gets automated lead-to-close pipelines, proposal
  generation, retainer upsell funnels, grant hunting, content calendars, VSL
  optimization, and client communication automation — all flowing through
  GHL, Stripe, Trello, and ManyChat.

- **CUTMV** gets a product growth engineering team — marketing automation, ad
  creative generation, customer support drafting, bug triage, feature
  shipping, pricing optimization, and funnel improvements — all backed by a
  Remotion video engine with 60+ motion specs.

- **DA** gets time back — the system handles research, documentation,
  summarization, workflow generation, and opportunity scouting so the founder
  can focus on strategy, creative direction, and relationships.

The cluster does not handle CUTMV's video rendering (that is the product's own
runtime). The cluster exists to **grow, market, improve, and sell** both
businesses.
