---
name: bird
description: X/Twitter CLI for reading, searching, and posting via cookies or Sweetistics.
homepage: https://bird.fast
metadata: {"clawdbot":{"emoji":"🐦","requires":{"bins":["bird"]},"install":[{"id":"brew","kind":"brew","formula":"steipete/tap/bird","bins":["bird"],"label":"Install bird (brew)"}]}}
---

# bird

Use `bird` to read/search X and post tweets/replies.

Quick start
- `bird whoami`
- `bird read <url-or-id>`
- `bird thread <url-or-id>`
- `bird search "query" -n 5`

Posting (confirm with user first)
- `bird tweet "text"`
- `bird reply <id-or-url> "text"`

Auth sources
- Browser cookies (default: Firefox/Chrome)
- Sweetistics API: set `SWEETISTICS_API_KEY` or use `--engine sweetistics`
- Check sources: `bird check`
