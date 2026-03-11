---
name: apollo-leadgen
description: "Apollo.io B2B lead prospecting: persona-based people search, email enrichment, deduplication, and opt-in batch preparation. Use when: (1) acquiring B2B leads for email subscriber growth, (2) running weekly or ad-hoc lead generation pulls, (3) evaluating lead pipeline health or enrichment credit usage, (4) planning outreach campaigns across 6 B2B personas, (5) preparing opt-in email batches for stakeholder approval."
---

# Apollo Lead Generation

## Overview

End-to-end B2B lead prospecting pipeline for VividWalls using Apollo.io People Search + Enrich API.

**Flow:** Apollo Search (6 personas) → Bulk Enrich (reveals emails) → Dedup → Export → Batch Prepare → Stakeholder Approval → Daily Send

**Script:** `~/.openclaw/workspace/businesses/vividwalls/marketing/apollo-lead-pull.py`
**Personas:** `~/.openclaw/workspace/businesses/vividwalls/marketing/persona-apollo-filters.json`

## Quick Commands

```bash
SCRIPT=~/.openclaw/workspace/businesses/vividwalls/marketing/apollo-lead-pull.py

# Pull leads for all 6 personas (search + enrich + dedup)
python3 $SCRIPT pull --max-pages 3

# Export unsent leads to apollo-prospects.txt
python3 $SCRIPT export

# Full pipeline: pull + export + prepare opt-in batch
python3 $SCRIPT feed --max-pages 3

# Dashboard: lead counts, enrichment history, persona breakdown
python3 $SCRIPT stats
```

**Flags:**
- `--max-pages N` — Pages per persona to search (default 3, each page ~25 results). Higher = more leads but more API credits.

## Decision Framework

### When to Pull

| Condition | Action |
|-----------|--------|
| Weekly cycle (Monday 06:00 UTC) | Automated via cron — runs `feed --max-pages 3` |
| Subscriber growth below 33/day target | Ad-hoc `feed` with `--max-pages 5` to accelerate |
| Pipeline has 0 unexported leads | Run `feed` to replenish |
| Unexported leads exist but no batches | Run `export` only, then prepare batches |
| Credits running low | Reduce `--max-pages` to 1-2, focus on top personas |

### When NOT to Pull

- Right after a pull (leads need time to go through send pipeline)
- If enrichment credits are depleted for the billing period
- If recent deliverability metrics show problems (fix deliverability first)

## Persona Strategy

Six B2B personas target VividWalls' commercial art buyer segments:

| Persona | Priority | Rationale |
|---------|----------|-----------|
| **Hospitality Buyer** | High | Hotels/resorts have highest AOV for wall art |
| **Corporate Buyer** | High | Office design budgets are recurring |
| **Healthcare Buyer** | Medium | Large facilities, long sales cycles |
| **Interior Designer** | Medium | Multiplier effect — designers buy for many clients |
| **Retail Buyer** | Medium | Visual merchandising needs are seasonal |
| **Real Estate Stager** | Lower | Smaller budgets but high volume |

Rotate underperforming personas by checking `stats` persona breakdown. If a persona yields <5% enrichment rate, consider adjusting titles or keywords in `persona-apollo-filters.json`.

See `references/personas.md` for detailed persona specs.

## Pipeline Monitoring

### Health Check Sequence

1. Run `stats` to see current pipeline state
2. Check **total leads** vs **unexported leads** — healthy pipeline has 50+ unexported
3. Check **enrichment rate** — should be >40% (emails found / people searched)
4. Check **credit usage** — each enrichment costs 1 credit; budget ~500/month
5. Check **persona breakdown** — ensure leads are distributed, not concentrated

### Key Metrics

- **Leads per pull:** Target 50-150 new verified leads per weekly pull
- **Enrichment rate:** >40% means persona targeting is good
- **Dedup rate:** High dedup rate (>30%) means personas overlap — adjust keywords
- **Export rate:** Unexported leads should not accumulate >500 (send pipeline is bottlenecked)

## Integration Points

### Downstream: Opt-In Email Pipeline

1. `feed` subcommand automatically calls `send-optin-batch.py prepare`
2. Batches are created in `optin-batches/` directory (50 emails per batch)
3. **Human approval required** — stakeholder reviews batch before send
4. Approved batches are sent via daily cron (staggered for deliverability)

### Upstream: Goals & Beliefs

- Feeds **G-CMO-2** (Build email list to 3,000 subscribers)
- Sub-goal **G-CMO-2a** tracks weekly B2B lead pipeline
- Update beliefs after each pull with lead quality observations

## Guardrails

- **Rate Limiting:** 1.2s delay between API calls (hardcoded in script)
- **Bulk Enrich Batch Size:** 10 IDs per call (Apollo API limit)
- **Credit Budget:** ~500 enrichment credits/month — monitor via `stats`
- **Dedup Layers:** Email-level dedup in `apollo-leads.json` (emails_seen array)
- **Human Approval:** No emails sent without stakeholder batch approval
- **Max Pages:** Keep at 3 for normal pulls, only increase to 5 for catch-up
