---
summary: "Bright Data search, scrape, structured web data, browser tools, and web_fetch fallback"
read_when:
  - You want Bright Data-backed web search or scraping
  - You need a Bright Data API token or zone config
  - You want Bright Data as a web_search provider
  - You want Bright Data as a hosted web_fetch fallback
title: "Bright Data"
---

# Bright Data

OpenClaw can use **Bright Data** in three ways:

- as the `web_search` provider
- as explicit plugin tools: `brightdata_search`, `brightdata_scrape`, batch tools, browser tools, and dataset-backed `brightdata_*` tools
- as a hosted fallback extractor for `web_fetch`

Bright Data is useful when you need live SERP results, bot-resistant scraping, dataset-backed web data, or a remote browser session for JS-heavy pages.

## Get an API token

1. Create a Bright Data account and generate an API token.
2. Store it in config or set `BRIGHTDATA_API_TOKEN` in the gateway environment.
3. Optional environment overrides:
   - `BRIGHTDATA_BASE_URL` (default: `https://api.brightdata.com`)
   - `BRIGHTDATA_UNLOCKER_ZONE` (default: `mcp_unlocker`)
   - `BRIGHTDATA_BROWSER_ZONE` (default: `mcp_browser`)

## Configure Bright Data search

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brightdata",
      },
    },
  },
  plugins: {
    entries: {
      brightdata: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "BRIGHTDATA_API_TOKEN_HERE",
            baseUrl: "https://api.brightdata.com",
          },
        },
      },
    },
  },
}
```

Notes:

- Choosing Bright Data in onboarding or `openclaw configure --section web` enables the bundled Bright Data plugin automatically.
- `web_search` with Bright Data supports `query` and `count`.
- For Bright Data-specific search controls like `engine`, `cursor`, or `geo_location`, use `brightdata_search`.
- `plugins.entries.brightdata.config.webSearch.apiKey` supports SecretRef objects.
- Legacy `tools.web.search.brightdata.*` still migrates for compatibility, but new configs should use `plugins.entries.brightdata.config.webSearch.*`.

## Configure Bright Data tools and `web_fetch` fallback

If you set `BRIGHTDATA_API_TOKEN` in the gateway environment, the bundled Bright Data tools and the `web_fetch` fallback can share it.

```json5
{
  plugins: {
    entries: {
      brightdata: {
        enabled: true,
      },
    },
  },
  tools: {
    web: {
      fetch: {
        brightdata: {
          enabled: true,
          baseUrl: "https://api.brightdata.com",
          unlockerZone: "mcp_unlocker",
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

Notes:

- Search, scrape, batch, browser, and dataset tools use `plugins.entries.brightdata.config.webSearch.apiKey` or `BRIGHTDATA_API_TOKEN`.
- `web_fetch` uses `tools.web.fetch.brightdata.*` plus the same `BRIGHTDATA_API_TOKEN` env fallback.
- `tools.web.fetch.brightdata.enabled` defaults to `true` when an API token is available.
- `tools.web.fetch.brightdata.apiKey` supports SecretRef objects.
- Search, scrape, and `web_fetch` use the unlocker zone. Browser tools use the browser zone.

## Bright Data plugin tools

### `brightdata_search`

Use this when you want Bright Data-specific search controls instead of generic `web_search`.

Core parameters:

- `query`
- `engine` (`google`, `bing`, or `yandex`)
- `count`
- `cursor`
- `geo_location`
- `timeoutSeconds`

### `brightdata_scrape`

Use this for bot-protected pages or pages where plain `web_fetch` is weak.

Core parameters:

- `url`
- `extractMode` (`markdown`, `text`, or `html`)
- `maxChars`
- `timeoutSeconds`

### Batch tools

- `brightdata_search_batch` runs up to 5 Bright Data searches in parallel.
- `brightdata_scrape_batch` runs up to 5 Bright Data scrapes in parallel.

### Browser tools

The Bright Data plugin registers a browser tool suite backed by Bright Data Browser API:

- `brightdata_browser_navigate`
- `brightdata_browser_go_back`
- `brightdata_browser_go_forward`
- `brightdata_browser_snapshot`
- `brightdata_browser_click`
- `brightdata_browser_type`
- `brightdata_browser_screenshot`
- `brightdata_browser_get_html`
- `brightdata_browser_get_text`
- `brightdata_browser_scroll`
- `brightdata_browser_scroll_to`
- `brightdata_browser_wait_for`
- `brightdata_browser_network_requests`
- `brightdata_browser_fill_form`

Typical flow:

1. Navigate with `brightdata_browser_navigate`
2. Capture refs with `brightdata_browser_snapshot`
3. Use those refs with `brightdata_browser_click`, `brightdata_browser_type`, `brightdata_browser_wait_for`, or `brightdata_browser_fill_form`

Notes:

- Browser tools use `mcp_browser` by default (`BRIGHTDATA_BROWSER_ZONE` can override it).
- The extension ships with `playwright` in its own package dependencies. If a custom install skipped extension dependencies, reinstall the extension.

### Structured web data tools

OpenClaw currently registers **47** dataset-backed `brightdata_*` tools. These trigger a Bright Data dataset job, poll for the snapshot result, and return structured JSON with the Bright Data `snapshotId` and `datasetId` preserved in the response.

Most tools take a `url`. A smaller set uses `keyword`, `prompt`, or extra fields like `first_name`, `last_name`, `num_of_reviews`, `num_of_comments`, `days_limit`, `start_date`, or `end_date`.

Categories:

- E-commerce: `brightdata_amazon_product`, `brightdata_amazon_product_reviews`, `brightdata_amazon_product_search`, `brightdata_bestbuy_products`, `brightdata_ebay_product`, `brightdata_etsy_products`, `brightdata_google_shopping`, `brightdata_homedepot_products`, `brightdata_walmart_product`, `brightdata_walmart_seller`, `brightdata_zara_products`
- Social and creator platforms: `brightdata_facebook_company_reviews`, `brightdata_facebook_events`, `brightdata_facebook_marketplace_listings`, `brightdata_facebook_posts`, `brightdata_instagram_comments`, `brightdata_instagram_posts`, `brightdata_instagram_profiles`, `brightdata_instagram_reels`, `brightdata_linkedin_company_profile`, `brightdata_linkedin_job_listings`, `brightdata_linkedin_people_search`, `brightdata_linkedin_person_profile`, `brightdata_linkedin_posts`, `brightdata_reddit_posts`, `brightdata_tiktok_comments`, `brightdata_tiktok_posts`, `brightdata_tiktok_profiles`, `brightdata_tiktok_shop`, `brightdata_x_posts`, `brightdata_x_profile_posts`, `brightdata_youtube_comments`, `brightdata_youtube_profiles`, `brightdata_youtube_videos`
- Business and research: `brightdata_apple_app_store`, `brightdata_booking_hotel_listings`, `brightdata_crunchbase_company`, `brightdata_github_repository_file`, `brightdata_google_maps_reviews`, `brightdata_google_play_store`, `brightdata_reuter_news`, `brightdata_yahoo_finance_business`, `brightdata_zillow_properties_listing`, `brightdata_zoominfo_company_profile`
- AI visibility and GEO: `brightdata_chatgpt_ai_insights`, `brightdata_grok_ai_insights`, `brightdata_perplexity_ai_insights`

There is no standalone `brightdata_extract` tool in this branch.

## How `web_fetch` uses Bright Data

`web_fetch` does not default to Bright Data first. It uses Bright Data only when a local fetch path is weak or a hosted fallback is explicitly needed.

For HTML pages, the extraction order is:

1. Direct fetch + Readability
2. Firecrawl (if configured)
3. Bright Data (if configured)
4. Basic HTML cleanup

For network errors or non-OK HTTP responses, `web_fetch` skips straight to the hosted fallback chain: Firecrawl first, then Bright Data.

See [Web tools](/tools/web) for shared `web_search` and `web_fetch` setup.
