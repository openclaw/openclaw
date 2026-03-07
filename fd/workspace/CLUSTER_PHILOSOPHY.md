# CLUSTER_PHILOSOPHY.md

## The Rule

> If a task helps acquire customers, improve conversion, optimize ads,
> ship code, or automate operations — it belongs in OpenClaw.
>
> If a task is heavy media processing for end-user output — that is not
> what the OpenClaw cluster should be optimized around.

---

## What the OpenClaw Cluster Is

The OpenClaw cluster is a **multi-agent growth-ops and founder-ops system**
for Full Digital and CUTMV.

Its primary job:

- Marketing ops
- Ad generation
- Lead gen systems
- Landing page creation and testing
- Code changes and product iteration
- Site optimization
- Funnel automation
- Campaign analysis
- Growth execution

The cluster should feel like:

- An autonomous growth team
- An autonomous product ops team
- An autonomous marketing engineer
- An autonomous landing-page lab
- An autonomous ad-creative engine
- An autonomous funnel optimizer

---

## What the OpenClaw Cluster Is NOT

The cluster is **not** a render farm, media processing pipeline, or compute
layer for end-user FFmpeg jobs.

CUTMV's codebase includes video-processing logic (FFmpeg, R2 storage,
ZIP packaging). That is **product runtime** — it belongs to the CUTMV
application itself, not to the cluster's mission.

The cluster should never be optimized around:

- Running FFmpeg renders for end users
- Processing video uploads
- Serving as a media compute layer
- Acting as infrastructure for CUTMV's processing pipeline

Those concerns are handled by CUTMV's own runtime (currently Railway)
or dedicated infrastructure if scale demands it later.

---

## Two Distinct Roles

### 1. OpenClaw Cluster = The Brain

The growth and automation intelligence layer. It:

- Writes and revises ads
- Generates hooks and creatives
- Spins up landing pages
- Runs experiments
- Analyzes campaign performance
- Improves conversion paths
- Manages CRM and funnel logic
- Edits code across Full Digital and CUTMV
- Monitors site issues
- Creates automations and internal tooling

### 2. CUTMV = The Product Being Operated

A SaaS product inside the monorepo that OpenClaw can:

- Inspect and understand
- Modify and improve
- Market and sell
- Deploy and monitor
- Measure and optimize

CUTMV is not a workload for the cluster. It is a product the cluster
helps grow.

---

## How CUTMV Fits Inside the Monorepo

CUTMV lives at `packages/cutmv-app/` because the monorepo enables:

- **Product improvement** — agents can read and edit the codebase directly
- **Marketing velocity** — launch landing pages, test CTAs, optimize pricing
- **Bug fixes** — patch code, deploy changes, monitor issues
- **Retention** — improve onboarding, checkout, subscription UX
- **Documentation** — generate support docs, feature guides, API docs
- **Data integration** — connect product data to marketing systems

It does NOT live in the monorepo so that the cluster can:

- Run video processing jobs
- Serve as a rendering backend
- Replace Railway or dedicated compute
- Become an FFmpeg execution layer

---

## What OpenClaw Should Do for CUTMV

### Product

- Ship new features
- Fix bugs
- Improve onboarding
- Optimize pricing pages
- Refine upsells
- Improve subscription and conversion UX

### Marketing

- Generate ad concepts
- Write ad copy
- Build creatives
- Make landing pages
- Test offers
- Segment audiences
- Analyze winners and losers

### Sales / Funnel

- Push DM-to-subscription flows
- Improve email follow-up
- Optimize lead capture
- Improve checkout and retention

### Ops

- Monitor site issues
- Patch code
- Deploy changes
- Manage experiments
- Document workflows

---

## Where Rendering / Media Execution Belongs

Video processing is internal product logic:

- **Currently**: handled inside CUTMV's own runtime on Railway
- **If scale demands it**: offloaded to dedicated compute (Cloudflare
  Workers, separate render nodes, or a managed service)
- **Never**: absorbed into the OpenClaw cluster's core mission

The cluster may help _build and improve_ the rendering pipeline code.
It should not _become_ the rendering pipeline.

---

## Decision Filter

When evaluating whether a task belongs to the cluster:

| Question                                          | If Yes          | If No            |
| ------------------------------------------------- | --------------- | ---------------- |
| Does it help acquire customers?                   | Cluster work    | Not cluster work |
| Does it improve conversion?                       | Cluster work    | Not cluster work |
| Does it optimize ads or campaigns?                | Cluster work    | Not cluster work |
| Does it ship code or fix bugs?                    | Cluster work    | Not cluster work |
| Does it automate business operations?             | Cluster work    | Not cluster work |
| Is it heavy media processing for end-user output? | Product runtime | —                |

---

## Summary

The OpenClaw cluster exists to help Full Digital and CUTMV grow —
through marketing, automation, product improvement, and operational
leverage.

CUTMV is a product the cluster operates on behalf of the founder.
The cluster builds, improves, markets, and sells the product.
The cluster does not become the product's compute infrastructure.
