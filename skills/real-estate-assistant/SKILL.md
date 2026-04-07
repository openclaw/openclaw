---
name: real-estate-assistant
description: AI assistant toolkit for real estate agents. Manages leads from ~/openclaw-work/realestate/leads.json, drafts property listing descriptions, sets follow-up reminders, and generates weekly pipeline summaries. Use whenever an agent needs to log a new lead, draft a listing, check follow-ups due today, or get a pipeline report.
---

# Real Estate Assistant

## Overview
A purpose-built skill for real estate agents running OpenClaw. Tracks leads through the pipeline, drafts property listing descriptions from structured data, and surfaces follow-ups so nothing slips through the cracks.

## Quick Start
1. **Add a lead:**
   ```bash
   cd /Users/chenjiaxuan/openclaw/skills/real-estate-assistant
   python scripts/realestate.py --add-lead --name "John Smith" --phone "555-1234" --email "john@email.com" --status prospect --notes "Interested in 3BR under $600k"
   ```
2. **Check today's follow-ups:**
   ```bash
   python scripts/realestate.py --follow-ups
   ```
3. **Draft a property listing:**
   ```bash
   python scripts/realestate.py --draft-listing --address "123 Main St" --beds 3 --baths 2 --sqft 1800 --price 550000 --features "open plan, renovated kitchen, large backyard"
   ```
4. **Weekly pipeline summary:**
   ```bash
   python scripts/realestate.py --pipeline
   ```

## Workflow

### 1. Lead Management
- Leads are stored in `~/openclaw-work/realestate/leads.json`
- Each lead tracks: name, contact, status, next follow-up date, notes history
- Statuses: `prospect` → `active` → `offer` → `closed` → `lost`
- Use `--update-lead` to move leads through the pipeline

### 2. Follow-Up Reminders
- `--follow-ups` shows all leads with a follow-up due today or overdue
- `--set-followup` sets the next follow-up date for a lead
- Run daily to never miss a client check-in

### 3. Listing Drafts
- Provide property specs and the script generates a ready-to-post listing description
- Output saved to `~/openclaw-work/realestate/listings/` as markdown
- Supports `--tone` flag: `professional`, `warm`, `luxury` (default: professional)

### 4. Pipeline Report
- `--pipeline` prints a full summary grouped by status
- Shows total leads, active deals, and estimated pipeline value
- Add `--week` to filter to leads updated this week

## Scripts
| Path | Purpose |
|---|---|
| `scripts/realestate.py` | Main CLI: lead management, follow-ups, listing drafts, pipeline reports |

## References & Assets
- [`references/lead-schema.md`](references/lead-schema.md): Lead data structure and status definitions
- [`assets/listing-template.md`](assets/listing-template.md): Property listing markdown template
