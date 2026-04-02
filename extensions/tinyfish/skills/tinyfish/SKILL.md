---
name: tinyfish
description: TinyFish hosted browser automation for complex public web workflows.
metadata:
  { "openclaw": { "emoji": "🐟", "requires": { "config": ["plugins.entries.tinyfish.enabled"] } } }
---

# TinyFish Automation

## When to use which tool

| Need                        | Tool                  | When                                                                |
| --------------------------- | --------------------- | ------------------------------------------------------------------- |
| Simple page fetch           | `web_fetch`           | Static content, no JS rendering needed                              |
| Web search                  | `web_search`          | Finding pages by query                                              |
| Direct browser control      | `browser`             | Need step-by-step CDP control or local browser access               |
| Complex public web workflow | `tinyfish_automation` | Multi-step forms, JS-heavy pages, bot-protected sites, geo-proxying |

## tinyfish_automation

Use when you need hosted browser automation for public websites that require
real browser interaction beyond what `web_fetch` or `web_search` can handle.

| Parameter         | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `url`             | Target public website URL (required)                     |
| `goal`            | Natural-language description of the task (required)      |
| `browser_profile` | `lite` (default, fast) or `stealth` (anti-bot mode)      |
| `proxy_config`    | Optional proxy routing with `enabled` and `country_code` |

### Browser profiles

| Profile   | Speed  | Anti-bot | Best for                                   |
| --------- | ------ | -------- | ------------------------------------------ |
| `lite`    | Faster | Basic    | Standard pages, forms, JS-rendered content |
| `stealth` | Slower | Strong   | Cloudflare, DataDome, bot-protected sites  |

### Tips

- **Start with `lite`** and escalate to `stealth` only if the site blocks access.
- **Keep goals specific** — "extract all product prices as JSON" works better than "look at the page."
- **Use `proxy_config`** with a `country_code` when content varies by region.
- **Prefer `web_fetch`** for simple static pages — TinyFish is for when you need a real browser.
- **Prefer `browser`** when you need direct local browser control or persistent sessions.

### Return shape

| Field           | Description                                           |
| --------------- | ----------------------------------------------------- |
| `run_id`        | TinyFish run identifier                               |
| `status`        | `COMPLETED`, `FAILED`, or other terminal status       |
| `result`        | Structured extraction result (when successful)        |
| `error`         | Error details (when failed)                           |
| `streaming_url` | Live browser session URL (when TinyFish provides one) |
| `help_url`      | Link to relevant TinyFish docs (on error)             |
| `help_message`  | Human-readable help hint (on error)                   |

## Choosing the right workflow

Follow this escalation pattern — start simple, escalate only when needed:

1. **`web_fetch`** — Simple page content, no JS rendering needed.
2. **`web_search`** — Find pages by query.
3. **`tinyfish_automation`** — Complex public workflows, forms, JS-heavy pages, bot-protected sites.
4. **`browser`** — Direct local browser control, persistent sessions, private/authenticated pages.
