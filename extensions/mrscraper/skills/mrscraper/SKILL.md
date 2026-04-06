---
name: mrscraper
description: MrScraper unblocker and AI scraping tools for blocked pages and structured extraction.
metadata:
  { "openclaw": { "emoji": "🕸️", "requires": { "config": ["plugins.entries.mrscraper.enabled"] } } }
---

# MrScraper Tools

## When to use which tool

| Need                              | Tool                   | When                                                                |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| Blocked or JS-heavy page fetch    | `web_fetch`            | MrScraper can power `web_fetch` when selected as the fetch provider |
| Rendered HTML plus extracted text | `mrscraper_fetch_html` | Need unblocker controls like `geoCode` or `blockResources`          |
| AI-powered structured extraction  | `mrscraper_scrape`     | Need schema-free extraction from plain-language instructions        |

## web_fetch

When `mrscraper` is the selected `web_fetch` provider, OpenClaw routes normal
`web_fetch` calls through MrScraper's unblocker.

| Parameter     | Description                 |
| ------------- | --------------------------- |
| `url`         | HTTP or HTTPS URL to fetch  |
| `extractMode` | `markdown` or `text`        |
| `maxChars`    | Maximum returned characters |

## mrscraper_fetch_html

Use this when you need unblocker-specific controls or want both rendered HTML
and extracted text back in one tool result.

| Parameter        | Description                                     |
| ---------------- | ----------------------------------------------- |
| `url`            | HTTP or HTTPS URL to fetch                      |
| `extractMode`    | `markdown` or `text`                            |
| `maxChars`       | Maximum returned characters                     |
| `timeoutSeconds` | Request timeout                                 |
| `geoCode`        | Optional country routing code like `US` or `SG` |
| `blockResources` | Block images/fonts/resources for faster loads   |

## mrscraper_scrape

Use this when you want MrScraper to create an AI scraper run from natural-language
instructions.

| Parameter         | Description                                    |
| ----------------- | ---------------------------------------------- | --- | --- |
| `url`             | Target page or site                            |
| `message`         | What to extract                                |
| `agent`           | `general`, `listing`, or `map`                 |
| `proxyCountry`    | Optional ISO country code                      |
| `maxDepth`        | `map` agent only                               |
| `maxPages`        | `map` agent only                               |
| `limit`           | `map` agent only                               |
| `includePatterns` | `map` agent only; regex patterns joined with ` |     | `   |
| `excludePatterns` | `map` agent only; regex patterns joined with ` |     | `   |

## Tips

- Start with `web_fetch` or `mrscraper_fetch_html` when you mainly need page contents.
- Use `mrscraper_scrape` when you need structured extracted data instead of raw page text.
- Prefer the `map` agent only when the task really needs multi-page crawling.
