---
name: mrscraper-cli
description: Official MrScraper CLI for terminal scraping, AI extraction jobs, and polling results outside OpenClaw's built-in tools.
homepage: https://www.npmjs.com/package/@mrscraper/cli
metadata:
  {
    "openclaw":
      {
        "emoji": "🕷️",
        "requires": { "bins": ["mrscraper"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "@mrscraper/cli",
              "bins": ["mrscraper"],
              "label": "Install @mrscraper/cli (global npm)",
            },
          ],
      },
  }
---

# MrScraper CLI

Use the `mrscraper` command for scripted or agent-driven flows that mirror the
[MrScraper](https://app.mrscraper.com) dashboard from the terminal. OpenClaw's
bundled **MrScraper plugin** exposes related capabilities as agent tools; this
skill covers the standalone CLI when you want the same platform from your shell.

## Install

```bash
npm install -g @mrscraper/cli
```

Or run without a global install: `npx --yes @mrscraper/cli --help`

## Auth

- Interactive: `mrscraper login`
- Non-interactive: `mrscraper login --api-key "$MRSCRAPER_API_KEY"`
- Environment: `MRSCRAPER_API_KEY` or `MRSCRAPER_API_TOKEN` (see upstream docs)

## Common commands

- `mrscraper scrape "<url>"` — HTML render, or add `--prompt` / `--agent` for AI mode
- `mrscraper results` / `mrscraper result --id <uuid>` — inspect job output
- `mrscraper --help` — full reference

Package and changelog: https://www.npmjs.com/package/@mrscraper/cli
