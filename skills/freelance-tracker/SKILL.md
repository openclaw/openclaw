---
name: freelance-tracker
description: Track freelance clients, log hours, and generate markdown invoices from ~/openclaw-work/freelance/clients/<client>/config.json. Use whenever you need to log time, summarize hours, or produce a ready-to-send invoice for a client.
---

# Freelance Tracker

## Overview

Keeps a running log of hours worked per client and project, then generates clean markdown invoices you can copy-paste or convert to PDF. All data lives in plain JSON files you own.

## Quick Start

1. **Initialize a client** (run once per client):
   ```bash
   cd /Users/chenjiaxuan/openclaw/skills/freelance-tracker
   python scripts/freelance_tracker.py --init-client <client-slug> --rate 100
   ```
2. **Log hours:**
   ```bash
   python scripts/freelance_tracker.py --client <client-slug> --log "2h project-name: built login page"
   ```
3. **Show summary for current week:**
   ```bash
   python scripts/freelance_tracker.py --client <client-slug> --summary
   ```
4. **Generate an invoice:**
   ```bash
   python scripts/freelance_tracker.py --client <client-slug> --invoice
   ```
   Output lands in `~/openclaw-work/freelance/out/<client>/invoice_YYYY-MM-DD.md`.

## Workflow

### 1. Set Up a Client

- Config lives at `~/openclaw-work/freelance/clients/<client>/config.json`.
- Set `name`, `email`, `rate` (hourly, USD), and optional `currency` and `payment_terms`.
- Use `--init-client` flag to scaffold it automatically.

### 2. Log Time

- Format: `<Nh> <project>: <description>` — e.g. `2.5h openclaw-setup: configured gateway and channels`
- Entries are appended to `~/openclaw-work/freelance/clients/<client>/log.json` with an ISO timestamp.
- Use `--date YYYY-MM-DD` to backfill past entries.

### 3. Summarize Hours

- `--summary` prints a table of all unbilled entries grouped by project.
- Add `--week` or `--month` to filter by period.
- Add `--all` to include already-billed entries.

### 4. Generate Invoice

- Reads all unbilled log entries, applies the hourly rate, and fills `assets/invoice-template.md`.
- Marks entries as billed so they won't appear on the next invoice.
- Supports `--dry-run` to preview without marking entries.

## Scripts

| Path                           | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `scripts/freelance_tracker.py` | Main CLI: init clients, log hours, summarize, and generate invoices. |

## References & Assets

- [`references/config-schema.md`](references/config-schema.md): Client config contract and field descriptions.
- [`assets/invoice-template.md`](assets/invoice-template.md): Markdown invoice skeleton injected on each run.
