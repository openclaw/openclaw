---
name: content-factory
description: Build exactly two SEO-friendly AI-tool articles per run by reading ~/openclaw-work/clients/<client>/config.json, scraping configured RSS + HTML sources, and writing markdown to ~/openclaw-work/out/articles/YYYY-MM-DD/<slug>.md. Trigger whenever a contributor needs trend-based AI tool content with outline, FAQ, and metadata prefilled.
---

# Content Factory

## Overview

Automates the creation of two SEO-grade articles that track trending AI tools: it pulls from curated feeds, assembles outlines/sections/FAQs, and drops polished markdown drafts into the dated `out/articles` folder.

## Quick Start

1. **Prepare client config** at `~/openclaw-work/clients/<client>/config.json` (schema + example in [`references/config-and-production.md`](references/config-and-production.md)). Include persona, CTA, RSS/HTML sources, and at least two article specs with keywords.
2. **Install dependencies (once):**
   ```bash
   pip install requests beautifulsoup4
   ```
3. **Run the factory:**
   ```bash
   cd /Users/chenjiaxuan/openclaw/skills/content-factory
   python scripts/run_content_factory.py --client <client-slug>
   ```
   Optional flags: `--date YYYY-MM-DD`, `--max-per-source 10`, `--dry-run`, `--init-dirs`.
4. **Polish outputs** in `~/openclaw-work/out/articles/<date>/`. Each run emits exactly two markdown files with frontmatter, outline, sections, FAQ, meta description, keywords, CTA, and source notes.

## Workflow

### 1. Configure Inputs

- `persona`, `cta`, and ordered `articles[]` entries (slug, title, primary keyword, keywords, angle, hook, optional outline/section/FAQ/meta overrides) live in the client config.
- Define ≥1 source of trending AI tools:
  - `html-list`: provide `item_selector`, `title_selector`, `description_selector`, `link_selector`.
  - `rss`: supply feed URL.
  - `api`: optional `path` + `mapping` to shape JSON payloads.
- Use [`references/config-and-production.md`](references/config-and-production.md) for the full JSON contract and checklist.

### 2. Harvest Signals (Web RSS + HTML)

- `scripts/run_content_factory.py` fetches all configured sources, dedupes tool names, and caps each feed via `--max-per-source`.
- HTML scraping relies on BeautifulSoup; inspect upstream DOM changes and adjust selectors as needed.
- RSS parsing runs through `xml.etree`; API payloads are navigated with dot-paths.

### 3. Generate Two SEO Articles

- The script always loads [`assets/seo-article-template.md`](assets/seo-article-template.md) twice—once per article spec.
- Template injects: YAML frontmatter (title, slug, keywords, meta description), numbered outline, three narrative sections, featured tool table, FAQ block, CTA, and source notes.
- Exactly two articles are produced each run (first two entries in `articles[]`). Missing entries cause the script to exit with an error.

### 4. QA & Delivery

- Ensure `primary_keyword` appears in intro, meta description, and CTA.
- Confirm at least three tools populate the table; bump `--max-per-source` if the feeds run light.
- Use `--dry-run` to preview markdown while refining selectors, outline bullets, or FAQ copy.

## Scripts

| Path                             | Purpose                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/run_content_factory.py` | CLI orchestrator. Reads the client config, scrapes RSS/HTML/API sources, fills the SEO template twice, and writes markdown to `~/openclaw-work/out/articles/<date>/`. Supports `--init-dirs`, `--dry-run`, and `--max-per-source`. |

## References & Assets

- [`references/config-and-production.md`](references/config-and-production.md): Config schema, selector guidance, and quality checklist.
- [`assets/seo-article-template.md`](assets/seo-article-template.md): Markdown boilerplate with outline, sections, FAQ, CTA, meta description, and source note placeholders.
