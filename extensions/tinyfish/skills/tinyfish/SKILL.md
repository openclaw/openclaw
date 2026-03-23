---
name: tinyfish
description: Use TinyFish for hosted browser automation on public multi-step web workflows.
metadata:
  {
    "openclaw":
      {
        "emoji": "🐟",
        "skillKey": "tinyfish",
        "requires": { "config": ["plugins.entries.tinyfish.enabled"] },
      },
  }
---

# TinyFish

Use `tinyfish_automation` when a task needs hosted browser automation on public
sites with multiple clicks, dynamic UI, forms, or geo-aware proxy execution.

Prefer TinyFish for:

- public multi-step workflows
- JS-heavy pages
- structured extraction from live browser sessions
- flows where a hosted remote browser is a better fit than the built-in local browser

Avoid TinyFish for:

- CAPTCHA solving
- persistent logged-in sessions across runs
- lightweight HTTP fetches that fit `web_fetch` or `web_search`

Config lives under `plugins.entries.tinyfish.config`.
