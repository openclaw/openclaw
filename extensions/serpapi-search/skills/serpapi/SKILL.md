---
name: serpapi
description: SerpApi search tools covering web, news, flights, hotels, maps, shopping, YouTube, scholar, finance, events, and trends.
metadata:
  { "openclaw": { "emoji": "🔎", "requires": { "config": ["plugins.entries.serpapi-search.enabled"] } } }
---

# SerpApi Tools

## When to use which tool

| Need                        | Tool                |
| --------------------------- | ------------------- |
| Web search                  | `web_search`        |
| Recent news articles        | `serpapi_news`      |
| Academic papers / citations | `serpapi_scholar`   |
| Local businesses / places   | `serpapi_maps`      |
| Product prices / shopping   | `serpapi_shopping`  |
| Job listings                | `serpapi_jobs`      |
| YouTube videos / channels   | `serpapi_youtube`   |
| Search trend data           | `serpapi_trends`    |
| Flight search               | `serpapi_flights`   |
| Hotel search                | `serpapi_hotels`    |
| Local events / concerts     | `serpapi_events`    |
| Stock / crypto / FX         | `serpapi_finance`   |

## web_search

SerpApi powers this automatically when selected as the search provider. Use for
general web queries where no specialized tool is needed.

## serpapi_news

Search Google News for recent articles.

| Parameter            | Description                                                         |
| -------------------- | ------------------------------------------------------------------- |
| `query`              | News query. Append `when:7d` for recency, e.g. `"AI when:7d"`.     |
| `count`              | Number of results (1–10, default: 5)                                |
| `so`                 | Sort: `0`=relevance (default), `1`=date                             |
| `gl`                 | Country code (e.g. `us`, `ua`)                                      |
| `hl`                 | Language code (e.g. `en`, `uk`)                                     |
| `topic_token`        | Browse a topic — use value from `menu_links[].topic_token`          |
| `publication_token`  | Filter by publisher — use value from `related_publications[]`       |
| `section_token`      | Sub-section of a topic or publisher                                 |
| `story_token`        | Full coverage of a specific story                                   |

Response also includes `menu_links` (topic navigation), `related_topics`, and `related_publications` — these contain tokens for follow-up calls.

### Tips
- `q` is optional when using `topic_token`, `publication_token`, or `story_token`.
- Use `story_token` to get full coverage of a breaking news event.

## serpapi_scholar

Search Google Scholar for academic papers.

| Parameter   | Description                                                              |
| ----------- | ------------------------------------------------------------------------ |
| `query`     | Academic query. Optional when using `cites` or `cluster`.               |
| `count`     | Results per page (1–20, default: 5)                                      |
| `as_ylo`    | Filter from year (e.g. `2020`)                                           |
| `as_yhi`    | Filter until year                                                        |
| `scisbd`    | Sort: `0`=relevance (default), `1`=date                                  |
| `cites`     | Find papers citing this article ID (from `result_id` in results)         |
| `cluster`   | Find all versions of this article ID                                     |
| `as_sdt`    | `0`=no patents (default), `7`=include patents, `4`=US case law           |
| `lr`        | Language restriction, pipe-separated (e.g. `"lang_en\|lang_de"`)        |
| `start`     | Pagination offset (0, 10, 20…)                                           |

Results include `inline_links.cited_by.total` (citation count) and `result_id` for follow-up `cites`/`cluster` calls.

## serpapi_maps

Find local businesses and places via Google Maps.

| Parameter  | Description                                                              |
| ---------- | ------------------------------------------------------------------------ |
| `query`    | Place or business type query                                             |
| `ll`       | GPS coordinates `@lat,lng,zoom` (e.g. `"@40.7128,-74.006,14z"`)         |
| `location` | City or area string (e.g. `"Austin, Texas"`)                            |
| `nearby`   | Force results near this location — use when query contains "near me"     |
| `count`    | Number of results (1–20, default: 5)                                     |
| `start`    | Pagination offset (0, 20, 40…, max recommended: 100)                    |
| `gl`       | Country code                                                             |

Response includes `serpapi_pagination.next` for fetching the next page.

### Tips
- Use `ll` for precise GPS-based search.
- Use `nearby` when the query contains "near me" phrases.

## serpapi_shopping

Search Google Shopping for products.

| Parameter       | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| `query`         | Product search query                                                 |
| `count`         | Number of results (1–20, default: 5)                                 |
| `min_price`     | Minimum price filter                                                 |
| `max_price`     | Maximum price filter                                                 |
| `sort_by`       | `1`=price low→high, `2`=price high→low                               |
| `free_shipping` | `true` to show only free shipping                                    |
| `on_sale`       | `true` to show only sale items                                       |
| `shoprs`        | Filter token from `filters[].options[].shoprs` in a previous result  |
| `start`         | Pagination offset (0, 60, 120…)                                      |
| `gl`            | Country code                                                         |

Response includes `filters` (with `shoprs` tokens for category refinement) and `serpapi_pagination`.

## serpapi_jobs

Search Google Jobs for job listings.

| Parameter          | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `query`            | Job search query (e.g. `"software engineer remote"`)                 |
| `count`            | Number of results (1–10, default: 5)                                 |
| `location`         | Location string (e.g. `"New York, NY"`)                              |
| `lrad`             | Search radius in kilometers                                          |
| `uds`              | Filter string from `filters[].parameters.uds` in a previous result  |
| `next_page_token`  | Token for next page (from `serpapi_pagination`)                      |

Response includes `filters` (with `uds` values for filtering) and `serpapi_pagination.next_page_token`. Up to 10 results per page.

### Tips
- Use `uds` from a previous response's `filters` array to apply job type/date filters.

## serpapi_youtube

Search YouTube for videos, channels, and shorts.

| Parameter | Description                                                       |
| --------- | ----------------------------------------------------------------- |
| `query`   | YouTube search query                                              |
| `sp`      | YouTube filter token (copy `sp` from a YouTube search URL)        |

Response includes `video_results`, `channel_results` (name, subscribers, handle), and `shorts_results`.

## serpapi_trends

Get Google Trends data.

| Parameter   | Description                                                                     |
| ----------- | ------------------------------------------------------------------------------- |
| `query`     | Search term(s). Up to 5 comma-separated for TIMESERIES/GEO_MAP.                |
| `data_type` | `TIMESERIES` (default), `GEO_MAP`, `GEO_MAP_0`, `RELATED_TOPICS`, `RELATED_QUERIES` |
| `geo`       | Region code (e.g. `US`, `UA`). Omit for worldwide.                              |
| `date`      | Range: `now 1-d`, `now 7-d`, `today 1-m`, `today 12-m` (default), `today 5-y` |
| `region`    | Breakdown level for GEO_MAP: `COUNTRY`, `REGION`, `DMA`, `CITY`                |
| `gprop`     | Property: `` (Web, default), `images`, `news`, `froogle`, `youtube`             |
| `cat`       | Category ID (default: `0` = all)                                                |
| `tz`        | Timezone offset in minutes (e.g. `-540` Tokyo, `420` PDT)                      |

Response includes `interest_over_time`, `interest_by_region`, `related_topics`, `related_queries` (whichever applies to the `data_type`).

## serpapi_flights

Search Google Flights for itineraries.

| Parameter       | Description                                               |
| --------------- | --------------------------------------------------------- |
| `departure_id`  | Departure IATA code (e.g. `JFK`, `KBP`)                  |
| `arrival_id`    | Arrival IATA code (e.g. `LAX`, `LHR`)                    |
| `outbound_date` | Date YYYY-MM-DD                                           |
| `return_date`   | Return date YYYY-MM-DD (omit for one-way)                 |
| `type`          | `1`=round trip (default), `2`=one-way                     |
| `adults`        | Number of adult passengers (default: `1`)                 |
| `currency`      | Currency code (default: `USD`)                            |
| `gl`            | Country code                                              |

Response includes `best_flights`, `other_flights` (each with `flights[]` legs, `price`, `total_duration`, `booking_token`), and `price_insights`.

## serpapi_hotels

Search Google Hotels for accommodation.

| Parameter          | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `query`            | Destination (e.g. `"Paris, France"`)                             |
| `check_in_date`    | YYYY-MM-DD (default: tomorrow)                                   |
| `check_out_date`   | YYYY-MM-DD (default: check-in + 2 nights)                        |
| `adults`           | Number of adults (default: `1`)                                  |
| `currency`         | Currency code (e.g. `USD`, `EUR`)                                |
| `gl`               | Country code                                                     |
| `sort_by`          | `3`=lowest price, `8`=highest rating, `13`=most reviewed         |
| `min_price`        | Minimum price per night                                          |
| `max_price`        | Maximum price per night                                          |
| `hotel_class`      | Star rating filter, comma-separated (e.g. `"4,5"`)              |
| `rating`           | Minimum rating: `7`=3.5+, `8`=4.0+, `9`=4.5+                   |
| `vacation_rentals` | `true` to search vacation rentals instead of hotels              |
| `next_page_token`  | Token for next page of results                                   |

Response includes `properties` and `ads` (sponsored listings).

## serpapi_events

Search Google Events for local events.

| Parameter   | Description                                                                        |
| ----------- | ---------------------------------------------------------------------------------- |
| `query`     | Event query (e.g. `"concerts in Austin"`)                                          |
| `location`  | Location string (e.g. `"Austin, Texas"`)                                           |
| `htichips`  | Date filter: `date:today`, `date:tomorrow`, `date:week`, `date:weekend`, `date:next_week`, `date:month` |
| `start`     | Pagination offset (0, 10, 20…)                                                     |
| `gl`        | Country code                                                                       |
| `hl`        | Language code                                                                      |

## serpapi_finance

Look up stock prices, cryptocurrency, FX rates, and market data via Google Finance.

| Parameter | Description                                                                 |
| --------- | --------------------------------------------------------------------------- |
| `query`   | Ticker or pair (e.g. `AAPL`, `BTC-USD`, `EUR-USD`, `NASDAQ:GOOGL`)         |
| `window`  | Time window: `1D` (default), `5D`, `1M`, `6M`, `YTD`, `1Y`, `5Y`, `MAX`   |

Response includes `summary` (price, movement, exchange), `markets` (US/Europe/Asia indices, currencies, crypto), `graph` (price history points), `knowledge_graph` (key stats), `financials` (income statement), `news_results`, and `discover_more`.
