---
name: mrscraper
description: MrScraper unblocker and AI scraping tools for blocked pages and structured extraction.
metadata:
  { "openclaw": { "emoji": "🕸️", "requires": { "config": ["plugins.entries.mrscraper.enabled"] } } }
---

# MrScraper Tools

## When to use which tool

| Need                              | Tool                                  | When                                                                |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| Blocked or JS-heavy page fetch    | `web_fetch`                           | MrScraper can power `web_fetch` when selected as the fetch provider |
| Rendered HTML plus extracted text | `mrscraper_fetch_html`                | Need unblocker controls like `geoCode` or `blockResources`          |
| AI-powered structured extraction  | `mrscraper_scrape`                    | Need schema-free extraction from plain-language instructions        |
| Reuse an AI scraper               | `mrscraper_rerun_ai_scraper`          | Apply an existing AI scraper to a new page or crawl target          |
| Batch AI reruns                   | `mrscraper_bulk_rerun_ai_scraper`     | Reuse one AI scraper across many URLs                               |
| Reuse a manual scraper            | `mrscraper_rerun_manual_scraper`      | Apply a dashboard manual scraper to a new URL                       |
| Batch manual reruns               | `mrscraper_bulk_rerun_manual_scraper` | Reuse one manual scraper across many URLs                           |
| Browse prior runs                 | `mrscraper_get_all_results`           | List stored results with sorting, paging, and filters               |
| Inspect one prior run             | `mrscraper_get_result_by_id`          | Fetch one detailed result by result ID                              |

## web_fetch

When `mrscraper` is the selected `web_fetch` provider, OpenClaw routes normal
`web_fetch` calls through MrScraper's unblocker.

| Parameter  | Description                 |
| ---------- | --------------------------- |
| `url`      | HTTP or HTTPS URL to fetch  |
| `maxChars` | Maximum returned characters |

## mrscraper_fetch_html

Use this when you need unblocker-specific controls or want both rendered HTML
and extracted text back in one tool result.

| Parameter        | Description                                     |
| ---------------- | ----------------------------------------------- |
| `url`            | HTTP or HTTPS URL to fetch                      |
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

## mrscraper_rerun_ai_scraper

Reuse an existing AI scraper on a new URL.

| Parameter         | Description                                    |
| ----------------- | ---------------------------------------------- | --- | --- |
| `scraperId`       | Existing AI scraper ID                         |
| `url`             | Target page or site                            |
| `maxDepth`        | `map` agent only                               |
| `maxPages`        | `map` agent only                               |
| `limit`           | `map` agent only                               |
| `includePatterns` | `map` agent only; regex patterns joined with ` |     | `   |
| `excludePatterns` | `map` agent only; regex patterns joined with ` |     | `   |

## mrscraper_bulk_rerun_ai_scraper

Reuse an existing AI scraper across multiple URLs.

| Parameter   | Description             |
| ----------- | ----------------------- |
| `scraperId` | Existing AI scraper ID  |
| `urls`      | One or more target URLs |

## mrscraper_rerun_manual_scraper

Reuse an existing manual scraper on a new URL.

| Parameter   | Description                |
| ----------- | -------------------------- |
| `scraperId` | Existing manual scraper ID |
| `url`       | Target page or site        |

## mrscraper_bulk_rerun_manual_scraper

Reuse an existing manual scraper across multiple URLs.

| Parameter   | Description                |
| ----------- | -------------------------- |
| `scraperId` | Existing manual scraper ID |
| `urls`      | One or more target URLs    |

## mrscraper_get_all_results

Browse previous MrScraper runs with optional paging and filtering.

| Parameter         | Description                      |
| ----------------- | -------------------------------- |
| `sortField`       | Sort column such as `updatedAt`  |
| `sortOrder`       | `ASC` or `DESC`                  |
| `pageSize`        | Number of results per page       |
| `page`            | Page number starting at 1        |
| `search`          | Optional text search             |
| `dateRangeColumn` | Optional date field to filter by |
| `startAt`         | Optional ISO start timestamp     |
| `endAt`           | Optional ISO end timestamp       |

## mrscraper_get_result_by_id

Fetch one detailed result object by result ID.

| Parameter  | Description        |
| ---------- | ------------------ |
| `resultId` | Result ID to fetch |

## Tips

- Start with `web_fetch` or `mrscraper_fetch_html` when you mainly need page contents.
- Use `mrscraper_scrape` when you need structured extracted data instead of raw page text.
- Use the rerun tools once you already have a saved scraper ID and want to reuse it.
- Use the result tools when you need to inspect prior jobs rather than launch a new scrape.
- Prefer the `map` agent only when the task really needs multi-page crawling.
