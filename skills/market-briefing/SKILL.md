---
name: market-briefing
description: Automate client-specific market briefings by loading ~/openclaw-work/clients/<client>/config.json, harvesting configured web/RSS/API sources, and writing ~/openclaw-work/out/<client>/briefing_YYYY-MM-DD.md using the provided template. Use whenever a contributor needs a repeatable way to summarize market intel per client dossier.
---

# Market Briefing Automation

## Overview

This skill standardizes the production of daily or weekly market briefings tied to a client slug. It handles configuration handoff, source harvesting, and template-driven output so you can focus on synthesis instead of path wrangling.

## Quick Start

1. **Identify the client slug** (matches folder under `~/openclaw-work/clients/`).
2. **Validate the config** using the schema in [`references/config-schema.md`](references/config-schema.md). Populate sources + focus priorities.
3. **Run the harvester**:
   ```bash
   cd /Users/chenjiaxuan/openclaw/skills/market-briefing
   python scripts/generate_briefing.py --client <client-slug>
   ```
   Add `--date YYYY-MM-DD` for backfills. Use `--init-dirs` once if the client/out folders do not exist.
4. **Open the generated file** at `~/openclaw-work/out/<client>/briefing_<date>.md`, replace placeholder bullets with your analysis, and attach links.

## Workflow

### 1. Prepare Client Context

- Store each client's metadata in `~/openclaw-work/clients/<client>/config.json`.
- Define `focus` topics in priority order—those become the talking points you highlight first.
- Make sure every source entry declares `type`, `url`, and either an HTML `selector`, an RSS feed, or API mapping. Lean on [`references/config-schema.md`](references/config-schema.md) for examples.

### 2. Harvest Sources (Web / RSS / API)

- `scripts/generate_briefing.py` supports three modes: `html` (CSS selectors via BeautifulSoup), `rss` (XML parsing), and `api` (JSON payloads).
- Install dependencies once per environment:
  ```bash
  pip install requests beautifulsoup4
  ```
- Override `--max-per-source` to throttle noisy feeds; defaults to 5 headlines per source.
- The script logs warnings instead of failing hard when an endpoint is down—check stderr if a section looks empty.

### 3. Draft the Briefing

- Output lives in `~/openclaw-work/out/<client>/briefing_<date>.md` and is pre-filled with the layout from [`assets/briefing-template.md`](assets/briefing-template.md).
- Auto-collected headlines are appended under "Auto-Collected Headlines" so you can decide what to elevate into the Executive Summary.
- Custom sections declared in config (e.g., "Commodities Watch") render with stub tables or bullet lists—overwrite them with real analysis.

### 4. QA & Delivery

- Sanity-check timestamp, timezone, and link formatting.
- Verify that each cited data point includes a working hyperlink.
- If multiple briefings run per day, re-run with `--date` to avoid overwriting or copy the file before iterating.

## Scripts

| Path                           | Purpose                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/generate_briefing.py` | CLI helper that reads the client config, fetches sources, merges the markdown template, and writes the dated briefing file. Supports `--dry-run` to preview markdown and `--init-dirs` to bootstrap the client folder structure. |

## References & Assets

- [`references/config-schema.md`](references/config-schema.md): Contract for client configs, including directory expectations and source definitions.
- [`assets/briefing-template.md`](assets/briefing-template.md): Markdown skeleton injected into each output; edit once to change the default briefing layout across clients.
