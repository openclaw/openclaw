---
name: serpapi
description: SerpApi search tools covering web, news, flights, hotels, maps, shopping, YouTube, scholar, finance, events, trends, weather, e-commerce, and more.
metadata:
  {
    "openclaw":
      { "emoji": "🔎", "requires": { "config": ["plugins.entries.serpapi-search.enabled"] } },
  }
---

# SerpApi Tools

## Configuration

Set your API key and optional default language under `config.webSearch`:

```json
{
  "plugins": {
    "entries": {
      "serpapi-search": {
        "config": {
          "webSearch": {
            "apiKey": "your-serpapi-key",
            "hl": "en"
          }
        }
      }
    }
  }
}
```

`apiKey` can also be provided via the `SERPAPI_API_KEY` environment variable. `hl` defaults to `en`.

## When to use which tool

| Need                             | Tool                         |
| -------------------------------- | ---------------------------- |
| Web search                       | `web_search`                 |
| Recent news articles             | `serpapi_news`               |
| Academic papers / citations      | `serpapi_scholar`            |
| Local businesses / places        | `serpapi_maps`               |
| Reviews for a place              | `serpapi_maps_reviews`       |
| Product prices / shopping        | `serpapi_shopping`           |
| Google AI Overview (AI answer)   | `serpapi_ai_overview`        |
| Amazon product search            | `serpapi_amazon`             |
| Amazon product details by ASIN   | `serpapi_amazon_product`     |
| eBay product search              | `serpapi_ebay`               |
| eBay product details by ID       | `serpapi_ebay_product`       |
| Walmart product search           | `serpapi_walmart`            |
| Walmart product details by ID    | `serpapi_walmart_product`    |
| Google Shopping product detail   | `serpapi_immersive_product`  |
| Job listings                     | `serpapi_jobs`               |
| YouTube videos / channels        | `serpapi_youtube`            |
| YouTube video metadata           | `serpapi_youtube_video`      |
| YouTube video transcript         | `serpapi_youtube_transcript` |
| Search trend data                | `serpapi_trends`             |
| Flight search                    | `serpapi_flights`            |
| Hotel search                     | `serpapi_hotels`             |
| Local events / concerts          | `serpapi_events`             |
| Stock / crypto / FX              | `serpapi_finance`            |
| Bing web search                  | `serpapi_bing`               |
| DuckDuckGo web search            | `serpapi_duckduckgo`         |
| Yahoo! web search                | `serpapi_yahoo`              |
| Query autocomplete suggestions   | `serpapi_autocomplete`       |
| Reverse image search             | `serpapi_lens`               |
| Tripadvisor places / restaurants | `serpapi_tripadvisor`        |
| Facebook public profile          | `serpapi_facebook_profile`   |
| Weather forecast                 | `serpapi_weather`            |

## web_search

SerpApi powers this automatically when selected as the search provider. Use for
general web queries where no specialized tool is needed.

## serpapi_news

Search Google News for recent articles.

| Parameter           | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `query`             | News query. Append `when:7d` for recency, e.g. `"AI when:7d"`. |
| `count`             | Number of results (1–10, default: 5)                           |
| `so`                | Sort: `0`=relevance (default), `1`=date                        |
| `gl`                | Country code (e.g. `us`, `ua`)                                 |
| `hl`                | Language code (e.g. `en`, `uk`)                                |
| `topic_token`       | Browse a topic — use value from `menu_links[].topic_token`     |
| `publication_token` | Filter by publisher — use value from `related_publications[]`  |
| `section_token`     | Sub-section of a topic or publisher                            |
| `story_token`       | Full coverage of a specific story                              |

Response also includes `menu_links` (topic navigation), `related_topics`, and `related_publications` — these contain tokens for follow-up calls.

### Tips

- `q` is optional when using `topic_token`, `publication_token`, or `story_token`.
- Use `story_token` to get full coverage of a breaking news event.

## serpapi_scholar

Search Google Scholar for academic papers.

| Parameter | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| `query`   | Academic query. Optional when using `cites` or `cluster`.        |
| `count`   | Results per page (1–20, default: 5)                              |
| `as_ylo`  | Filter from year (e.g. `2020`)                                   |
| `as_yhi`  | Filter until year                                                |
| `scisbd`  | Sort: `0`=relevance (default), `1`=date                          |
| `cites`   | Find papers citing this article ID (from `result_id` in results) |
| `cluster` | Find all versions of this article ID                             |
| `as_sdt`  | `0`=no patents (default), `7`=include patents, `4`=US case law   |
| `lr`      | Language restriction, pipe-separated (e.g. `"lang_en\|lang_de"`) |
| `start`   | Pagination offset (0, 10, 20…)                                   |

Results include `inline_links.cited_by.total` (citation count) and `result_id` for follow-up `cites`/`cluster` calls.

## serpapi_maps

Find local businesses and places via Google Maps.

| Parameter  | Description                                                          |
| ---------- | -------------------------------------------------------------------- |
| `query`    | Place or business type query                                         |
| `ll`       | GPS coordinates `@lat,lng,zoom` (e.g. `"@40.7128,-74.006,14z"`)      |
| `location` | City or area string (e.g. `"Austin, Texas"`)                         |
| `nearby`   | Force results near this location — use when query contains "near me" |
| `count`    | Number of results (1–20, default: 5)                                 |
| `start`    | Pagination offset (0, 20, 40…, max recommended: 100)                 |
| `gl`       | Country code                                                         |

Response includes `serpapi_pagination.next` for fetching the next page.

### Tips

- Use `ll` for precise GPS-based search.
- Use `nearby` when the query contains "near me" phrases.

## serpapi_amazon

Search Amazon for products across any marketplace.

| Parameter       | Description                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `query`         | Product search query                                                                                      |
| `amazon_domain` | Marketplace domain (e.g. `amazon.com`, `amazon.de`, `amazon.co.uk`, `amazon.co.jp`)                       |
| `language`      | Locale code (e.g. `en_US`, `de_DE`, `ja_JP`)                                                              |
| `s`             | Sort: `price-asc-rank`, `price-desc-rank`, `review-rank`, `date-desc-rank`, `exact-aware-popularity-rank` |
| `node`          | Category node ID (from Amazon URL or `filters[].node` in a previous response)                             |
| `rh`            | Attribute filter string from `filters[].rh` in a previous response                                        |
| `page`          | Page number for pagination (default: 1)                                                                   |

Response includes `organic_results` (with `asin`, `title`, `price`, `rating`, `reviews`, `prime`, `delivery`), `filters`, and `serpapi_pagination`.

### Tips

- Use `amazon_domain` + `language` together for non-US marketplaces.
- Use `node` or `rh` from a previous response's `filters` to narrow by category or attribute.
- Each `organic_results[].asin` can be used with the Amazon Product API for full product details.

## serpapi_shopping

Search Google Shopping for products.

| Parameter       | Description                                                         |
| --------------- | ------------------------------------------------------------------- |
| `query`         | Product search query                                                |
| `count`         | Number of results (1–20, default: 5)                                |
| `min_price`     | Minimum price filter                                                |
| `max_price`     | Maximum price filter                                                |
| `sort_by`       | `1`=price low→high, `2`=price high→low                              |
| `free_shipping` | `true` to show only free shipping                                   |
| `on_sale`       | `true` to show only sale items                                      |
| `shoprs`        | Filter token from `filters[].options[].shoprs` in a previous result |
| `start`         | Pagination offset (0, 60, 120…)                                     |
| `gl`            | Country code                                                        |

Response includes `filters` (with `shoprs` tokens for category refinement) and `serpapi_pagination`.

## serpapi_jobs

Search Google Jobs for job listings.

| Parameter         | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `query`           | Job search query (e.g. `"software engineer remote"`)               |
| `count`           | Number of results (1–10, default: 5)                               |
| `location`        | Location string (e.g. `"New York, NY"`)                            |
| `lrad`            | Search radius in kilometers                                        |
| `uds`             | Filter string from `filters[].parameters.uds` in a previous result |
| `next_page_token` | Token for next page (from `serpapi_pagination`)                    |

Response includes `filters` (with `uds` values for filtering) and `serpapi_pagination.next_page_token`. Up to 10 results per page.

### Tips

- Use `uds` from a previous response's `filters` array to apply job type/date filters.

## serpapi_youtube

Search YouTube for videos, channels, and shorts.

| Parameter | Description                                                |
| --------- | ---------------------------------------------------------- |
| `query`   | YouTube search query                                       |
| `sp`      | YouTube filter token (copy `sp` from a YouTube search URL) |

Response includes `video_results`, `channel_results` (name, subscribers, handle), and `shorts_results`.

## serpapi_trends

Get Google Trends data.

| Parameter   | Description                                                                         |
| ----------- | ----------------------------------------------------------------------------------- |
| `query`     | Search term(s). Up to 5 comma-separated for TIMESERIES/GEO_MAP.                     |
| `data_type` | `TIMESERIES` (default), `GEO_MAP`, `GEO_MAP_0`, `RELATED_TOPICS`, `RELATED_QUERIES` |
| `geo`       | Region code (e.g. `US`, `UA`). Omit for worldwide.                                  |
| `date`      | Range: `now 1-d`, `now 7-d`, `today 1-m`, `today 12-m` (default), `today 5-y`       |
| `region`    | Breakdown level for GEO_MAP: `COUNTRY`, `REGION`, `DMA`, `CITY`                     |
| `gprop`     | Property: ``(Web, default),`images`, `news`, `froogle`, `youtube`                   |
| `cat`       | Category ID (default: `0` = all)                                                    |
| `tz`        | Timezone offset in minutes (e.g. `-540` Tokyo, `420` PDT)                           |

Response includes `interest_over_time`, `interest_by_region`, `related_topics`, `related_queries` (whichever applies to the `data_type`).

## serpapi_flights

Search Google Flights for itineraries.

| Parameter       | Description                               |
| --------------- | ----------------------------------------- |
| `departure_id`  | Departure IATA code (e.g. `JFK`, `KBP`)   |
| `arrival_id`    | Arrival IATA code (e.g. `LAX`, `LHR`)     |
| `outbound_date` | Date YYYY-MM-DD                           |
| `return_date`   | Return date YYYY-MM-DD (omit for one-way) |
| `type`          | `1`=round trip (default), `2`=one-way     |
| `adults`        | Number of adult passengers (default: `1`) |
| `currency`      | Currency code (default: `USD`)            |
| `gl`            | Country code                              |

Response includes `best_flights`, `other_flights` (each with `flights[]` legs, `price`, `total_duration`, `booking_token`), and `price_insights`.

## serpapi_hotels

Search Google Hotels for accommodation.

| Parameter          | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `query`            | Destination (e.g. `"Paris, France"`)                     |
| `check_in_date`    | YYYY-MM-DD (default: tomorrow)                           |
| `check_out_date`   | YYYY-MM-DD (default: check-in + 2 nights)                |
| `adults`           | Number of adults (default: `1`)                          |
| `currency`         | Currency code (e.g. `USD`, `EUR`)                        |
| `gl`               | Country code                                             |
| `sort_by`          | `3`=lowest price, `8`=highest rating, `13`=most reviewed |
| `min_price`        | Minimum price per night                                  |
| `max_price`        | Maximum price per night                                  |
| `hotel_class`      | Star rating filter, comma-separated (e.g. `"4,5"`)       |
| `rating`           | Minimum rating: `7`=3.5+, `8`=4.0+, `9`=4.5+             |
| `vacation_rentals` | `true` to search vacation rentals instead of hotels      |
| `next_page_token`  | Token for next page of results                           |

Response includes `properties` and `ads` (sponsored listings).

## serpapi_events

Search Google Events for local events.

| Parameter  | Description                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `query`    | Event query (e.g. `"concerts in Austin"`)                                                               |
| `location` | Location string (e.g. `"Austin, Texas"`)                                                                |
| `htichips` | Date filter: `date:today`, `date:tomorrow`, `date:week`, `date:weekend`, `date:next_week`, `date:month` |
| `start`    | Pagination offset (0, 10, 20…)                                                                          |
| `gl`       | Country code                                                                                            |
| `hl`       | Language code                                                                                           |

## serpapi_finance

Look up stock prices, cryptocurrency, FX rates, and market data via Google Finance.

| Parameter | Description                                                             |
| --------- | ----------------------------------------------------------------------- |
| `query`   | Ticker or pair (e.g. `AAPL`, `BTC-USD`, `EUR-USD`, `NASDAQ:GOOGL`)      |
| `window`  | Time window: `1D` (default), `5D`, `1M`, `6M`, `YTD`, `1Y`, `5Y`, `MAX` |

Response includes `summary` (price, movement, exchange), `markets` (US/Europe/Asia indices, currencies, crypto), `graph` (price history points), `knowledge_graph` (key stats), `financials` (income statement), `news_results`, and `discover_more`.

## serpapi_maps_reviews

Fetch reviews for a place on Google Maps.

| Parameter         | Description                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `data_id`         | Google Maps data ID from `serpapi_maps` results. Either `data_id` or `place_id` required. |
| `place_id`        | Google Maps place ID. Either `place_id` or `data_id` required.                            |
| `hl`              | Language code (e.g. `en`, `uk`)                                                           |
| `sort_by`         | `qualityScore` (default), `newestFirst`, `ratingHigh`, `ratingLow`                        |
| `topic_id`        | Filter by topic ID from `topics[]` in the response. Cannot be used with `query`.          |
| `query`           | Text filter for reviews. Cannot be used with `topic_id`.                                  |
| `num`             | Number of reviews to return (1–20, default: 10)                                           |
| `next_page_token` | Pagination token from `serpapi_pagination.next_page_token`                                |

Response includes `place_info`, `topics`, `reviews` (rating, snippet, user, date), and `serpapi_pagination`.

### Tips

- Obtain `data_id` from `serpapi_maps` results.
- Use `topics[]` from the first response to pass `topic_id` for filtered follow-up calls.

## serpapi_ai_overview

Fetch a Google AI Overview (AI-generated answer) for a query.

| Parameter    | Description                                                             |
| ------------ | ----------------------------------------------------------------------- |
| `page_token` | Token from `ai_overview.page_token` in a `web_search` result. Required. |

Response includes `ai_overview` with `text_blocks`, `references`, and related content.

### Tips

- First run a `web_search` and check for `ai_overview.page_token` in the response.
- Tokens expire ~1 minute after the original Google search.

## serpapi_immersive_product

Fetch detailed Google Shopping product info including all seller prices.

| Parameter         | Description                                                         |
| ----------------- | ------------------------------------------------------------------- |
| `page_token`      | Token from `serpapi_link` in a `serpapi_shopping` result. Required. |
| `next_page_token` | Token for next page of stores (from `stores_next_page_token`)       |
| `more_stores`     | `true` to expand additional stores                                  |

Response includes `product_results` with title, brand, rating, price range, all store listings, thumbnails, reviews, and more.

## serpapi_bing

Search the web using Bing.

| Parameter    | Description                                                              |
| ------------ | ------------------------------------------------------------------------ |
| `query`      | Search query. Supports Bing operators: NOT, OR, site:, filetype:, near:. |
| `mkt`        | Market locale (e.g. `en-US`, `de-DE`). Takes precedence over `cc`.       |
| `cc`         | 2-letter country code (e.g. `us`, `de`). Cannot be used with `mkt`.      |
| `location`   | Location string (e.g. `"Seattle, Washington"`)                           |
| `safeSearch` | `Off`, `Moderate` (default), or `Strict` (case-sensitive)                |
| `first`      | Result offset: `1` (default), `11` page 2, `21` page 3, ...              |

## serpapi_duckduckgo

Search the web using DuckDuckGo.

| Parameter       | Description                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| `query`         | Search query                                                                     |
| `kl`            | Region code (e.g. `us-en`, `de-de`, `ua-uk`)                                     |
| `safe`          | SafeSearch: `1`=Strict, `-1`=Moderate, `-2`=Off                                  |
| `df`            | Date filter: `d`=day, `w`=week, `m`=month, `y`=year, or `YYYY-MM-DD..YYYY-MM-DD` |
| `m`             | Max results (1–50)                                                               |
| `start`         | Pagination offset                                                                |
| `search_assist` | `true` to enable search assist suggestions                                       |

Response includes `results`, `knowledge_graph`, `news_results`, `related_searches`, `search_assist`.

## serpapi_yahoo

Search the web using Yahoo!.

| Parameter      | Description                                                 |
| -------------- | ----------------------------------------------------------- |
| `query`        | Search query                                                |
| `yahoo_domain` | Domain prefix (e.g. `fr` for fr.search.yahoo.com)           |
| `vc`           | 2-letter country code (e.g. `us`, `gb`, `fr`)               |
| `vl`           | Language filter (e.g. `lang_fr` to search French only)      |
| `vm`           | Adult filter: `r`=Strict, `i`=Moderate, `p`=Off             |
| `vs`           | TLD filter, comma-separated (e.g. `.com,.org`)              |
| `vf`           | File format (e.g. `pdf`, `txt`)                             |
| `b`            | Pagination offset (default: 1, page 2: 11, page 3: 21, ...) |

## serpapi_autocomplete

Get Google search query completions.

| Parameter | Description                                                       |
| --------- | ----------------------------------------------------------------- |
| `query`   | Partial search query to get completions for                       |
| `gl`      | Country code (e.g. `us`, `ua`)                                    |
| `hl`      | Language code (e.g. `en`, `uk`)                                   |
| `cp`      | Cursor position (0-based, defaults to end of query)               |
| `client`  | Autocomplete client: `chrome`, `safari`, `firefox-b-d`, `youtube` |

Response includes `suggestions[]` with `value`, `relevance`, and `type`, plus `verbatim_relevance`.

## serpapi_lens

Perform a Google Lens reverse image search.

| Parameter   | Description                                                                        |
| ----------- | ---------------------------------------------------------------------------------- |
| `url`       | Public URL of the image to search. Required.                                       |
| `type`      | `all` (default), `about_this_image`, `products`, `exact_matches`, `visual_matches` |
| `q`         | Optional query to refine results (applies to `all`, `visual_matches`, `products`)  |
| `hl`        | Language code                                                                      |
| `country`   | 2-letter country code                                                              |
| `safe`      | `active` or `off`                                                                  |
| `auto_crop` | `true` to auto-crop to detected area of interest                                   |

Response includes `visual_matches`, `exact_matches`, `related_content`, `knowledge_graph`, `text_results`, `ai_overview`.

## serpapi_youtube_video

Fetch metadata for a YouTube video.

| Parameter         | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `v`               | YouTube video ID (e.g. `dQw4w9WgXcQ`). Required.                          |
| `hl`              | Language code                                                             |
| `gl`              | Country code                                                              |
| `next_page_token` | Paginate related videos or comments using tokens from a previous response |

Response includes `title`, `channel`, `views`, `likes`, `description`, `chapters`, `related_videos`, pagination tokens (`related_videos_next_page_token`, `comments_next_page_token`, `comments_sorting_token`), and a `transcript` link.

### Tips

- Use `related_videos_next_page_token` to page through related videos.
- Use `comments_next_page_token` or `comments_sorting_token[].token` to fetch comments.
- Use `serpapi_youtube_transcript` to get the full text transcript.

## serpapi_youtube_transcript

Fetch the transcript of a YouTube video.

| Parameter       | Description                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `v`             | YouTube video ID. Required.                                                                     |
| `language_code` | Language code (e.g. `en`, `es-ES`, `zh-Hans`). Defaults to `en`. Falls back to first available. |
| `title`         | Select a specific transcript by title (e.g. `"Twitch Chat - Simple"`)                           |
| `type`          | Transcript type: `asr` for auto-generated                                                       |

Response includes `transcript[]` (timestamped segments), `video_id`, `title`, `language_code`.

## serpapi_amazon_product

Fetch detailed Amazon product info by ASIN.

| Parameter           | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `asin`              | Amazon ASIN (e.g. `B072MQ5BRX` from amazon.com/dp/B072MQ5BRX). Required.  |
| `amazon_domain`     | Marketplace (e.g. `amazon.co.uk`, `amazon.de`). Defaults to `amazon.com`. |
| `language`          | Locale (e.g. `en_US`, `es_US`, `ja_JP`)                                   |
| `delivery_zip`      | ZIP/postal code for shipping availability                                 |
| `shipping_location` | Country for shipping filtering                                            |

Response includes `product` (title, price, rating, specs, variants, images), `purchase_options`, `related_products`, `bought_together`, `reviews_information`.

### Tips

- Get `asin` values from `serpapi_amazon` results.

## serpapi_ebay

Search eBay listings.

| Parameter       | Description                                                                               |
| --------------- | ----------------------------------------------------------------------------------------- |
| `query`         | Search query. Optional when `category_id` is set.                                         |
| `ebay_domain`   | eBay domain (e.g. `ebay.co.uk`, `ebay.de`). Defaults to `ebay.com`.                       |
| `buying_format` | `Auction`, `BIN` (Buy It Now), or `BO` (Accepts Offers)                                   |
| `show_only`     | Comma-separated flags: `Sold`, `FS` (Free shipping), `FR` (Free returns), `LPickup`, etc. |
| `min_price`     | Minimum price                                                                             |
| `max_price`     | Maximum price                                                                             |
| `sort`          | Sort numeric code (see serpapi.com/ebay-sort-options)                                     |
| `category_id`   | Category ID from `categories[]` in a previous result                                      |
| `condition`     | Condition ID(s): `1000`=New, `3000`=Used. Combine with `\|` (e.g. `1000\|3000`)           |
| `zip`           | ZIP/postal code for local shipping                                                        |
| `page`          | Page number (default: 1)                                                                  |
| `per_page`      | Results per page: `25`, `50` (default), `100`, `200`                                      |

Response includes `organic_results`, `filters`, `categories`, `serpapi_pagination`.

### Tips

- Use `organic_results[].product_id` with `serpapi_ebay_product` for full listing details.

## serpapi_ebay_product

Fetch detailed eBay listing info by product ID.

| Parameter          | Description                                                                       |
| ------------------ | --------------------------------------------------------------------------------- |
| `product_id`       | eBay item ID from the URL (e.g. `30557685` from ebay.com/itm/30557685). Required. |
| `ebay_domain`      | eBay domain (e.g. `ebay.co.uk`). Defaults to `ebay.com`.                          |
| `locale`           | Locale for search origin                                                          |
| `lang`             | Language override (US domain + locale only)                                       |
| `shipping_country` | Country code for shipping cost calculation                                        |

Response includes `product_results` (title, price, condition, specs, shipping, returns, media), `seller_results`, `related_products`.

## serpapi_tripadvisor

Search Tripadvisor for destinations, hotels, restaurants, and attractions.

| Parameter            | Description                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `query`              | Search query (e.g. `"Rome"`, `"best restaurants in Paris"`)                                            |
| `ssrc`               | Filter: `a`=All (default), `r`=Restaurants, `A`=Things to Do, `h`=Hotels, `g`=Destinations, `f`=Forums |
| `tripadvisor_domain` | Domain (e.g. `www.tripadvisor.co.uk`). Defaults to `tripadvisor.com`.                                  |
| `lat` / `lon`        | GPS coordinates for location-based search                                                              |
| `limit`              | Max results (1–100, default: 30)                                                                       |
| `offset`             | Pagination offset (0, 30, 60, ...)                                                                     |

Response includes `places`, `restaurants`, `hotels`, `attractions`, `serpapi_pagination`.

## serpapi_facebook_profile

Fetch a public Facebook profile.

| Parameter    | Description                                                              |
| ------------ | ------------------------------------------------------------------------ |
| `profile_id` | Profile slug or numeric ID (e.g. `Meta` or `100080376596424`). Required. |

Response includes `profile`, `posts`, `photos`, `videos`, `about`.

## serpapi_weather

Get weather for a location via Google.

| Parameter | Description                                                                               |
| --------- | ----------------------------------------------------------------------------------------- |
| `query`   | Natural language query (e.g. `"weather in Kyiv"`, `"forecast Paris tomorrow"`). Required. |
| `gl`      | Country code (e.g. `us`, `ua`)                                                            |
| `hl`      | Language code (e.g. `en`, `uk`)                                                           |

Response includes `answer_box` with `high`, `low`, `weather` (conditions), `date`, `location`, and `icon`.

## serpapi_walmart

Search Walmart product listings.

| Parameter        | Description                                                                  |
| ---------------- | ---------------------------------------------------------------------------- |
| `query`          | Search query. Optional when `cat_id` is set.                                 |
| `walmart_domain` | Domain (e.g. `walmart.ca`, `walmart.com.mx`). Defaults to `walmart.com`.     |
| `sort`           | `price_low`, `price_high`, `best_seller`, `best_match`, `rating_high`, `new` |
| `cat_id`         | Category ID (e.g. `0` for all). Either `query` or `cat_id` required.         |
| `facet`          | Attribute filter: `key:value` pairs separated by `\|\|`                      |
| `store_id`       | Filter by specific Walmart store                                             |
| `min_price`      | Minimum price                                                                |
| `max_price`      | Maximum price                                                                |
| `page`           | Page number (default: 1, max: 100)                                           |

Response includes `search_information`, `organic_results` (with `us_item_id`, `product_id`, price, rating), `serpapi_pagination`.

### Tips

- Use `organic_results[].product_id` with `serpapi_walmart_product` for full product details.

## serpapi_walmart_product

Fetch detailed Walmart product info by product ID.

| Parameter    | Description                                                               |
| ------------ | ------------------------------------------------------------------------- |
| `product_id` | Walmart product ID or `us_item_id` from URL (e.g. `138762768`). Required. |
| `store_id`   | Store ID for store-specific pricing                                       |

Response includes `product_result` (title, price, specs, stock, shipping/pickup/delivery options) and `reviews_results`.
