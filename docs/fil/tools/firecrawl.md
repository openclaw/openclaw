---
summary: "Fallback ng Firecrawl para sa web_fetch (anti-bot + naka-cache na extraction)"
read_when:
  - Gusto mo ng web extraction na naka-back sa Firecrawl
  - Kailangan mo ng Firecrawl API key
  - Gusto mo ng anti-bot extraction para sa web_fetch
title: "Firecrawl"
---

# Firecrawl

20. Maaaring gamitin ng OpenClaw ang **Firecrawl** bilang fallback extractor para sa `web_fetch`. 21. Ito ay isang hosted
    content extraction service na sumusuporta sa bot circumvention at caching, na nakakatulong
    sa mga site na mabigat sa JS o mga pahinang nagba-block ng plain HTTP fetches.

## Kumuha ng API key

1. Gumawa ng Firecrawl account at bumuo ng API key.
2. I-store ito sa config o itakda ang `FIRECRAWL_API_KEY` sa environment ng Gateway.

## I-configure ang Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

Mga tala:

- Ang `firecrawl.enabled` ay default na true kapag may API key.
- 22. Kinokontrol ng `maxAgeMs` kung gaano katanda ang maaaring maging cached na mga resulta (ms). 23. Ang default ay 2 araw.

## Stealth / bot circumvention

Firecrawl exposes a **proxy mode** parameter for bot circumvention (`basic`, `stealth`, or `auto`).
OpenClaw always uses `proxy: "auto"` plus `storeInCache: true` for Firecrawl requests.
24. Kapag hindi tinukoy ang proxy, ang Firecrawl ay nagde-default sa `auto`. 25. Ang `auto` ay muling sumusubok gamit ang stealth proxies kung pumalya ang isang basic na pagtatangka, na maaaring gumamit ng mas maraming credits
kaysa sa basic-only scraping.

## Paano ginagamit ng `web_fetch` ang Firecrawl

Ang pagkakasunod-sunod ng extraction ng `web_fetch`:

1. Readability (local)
2. Firecrawl (kung naka-configure)
3. Basic HTML cleanup (huling fallback)

Tingnan ang [Web tools](/tools/web) para sa kumpletong setup ng web tool.
