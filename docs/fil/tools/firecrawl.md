---
summary: "Fallback ng Firecrawl para sa web_fetch (anti-bot + naka-cache na extraction)"
read_when:
  - Gusto mo ng web extraction na naka-back sa Firecrawl
  - Kailangan mo ng Firecrawl API key
  - Gusto mo ng anti-bot extraction para sa web_fetch
title: "Firecrawl"
x-i18n:
  source_path: tools/firecrawl.md
  source_hash: 08a7ad45b41af412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:57Z
---

# Firecrawl

Maaaring gumamit ang OpenClaw ng **Firecrawl** bilang fallback extractor para sa `web_fetch`. Isa itong hosted
na serbisyo para sa content extraction na sumusuporta sa bot circumvention at caching, na nakakatulong
para sa mga site na mabigat sa JS o mga page na nagba-block ng karaniwang HTTP fetches.

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
- Kinokontrol ng `maxAgeMs` kung gaano katanda ang maaaring mga naka-cache na resulta (ms). Ang default ay 2 araw.

## Stealth / bot circumvention

Nag-e-expose ang Firecrawl ng **proxy mode** parameter para sa bot circumvention (`basic`, `stealth`, o `auto`).
Palaging ginagamit ng OpenClaw ang `proxy: "auto"` kasama ang `storeInCache: true` para sa mga request ng Firecrawl.
Kung wala ang proxy, ang default ng Firecrawl ay `auto`. Ang `auto` ay nagre-retry gamit ang stealth proxies kapag pumalya ang basic na attempt, na maaaring gumamit ng mas maraming credits
kumpara sa basic-only scraping.

## Paano ginagamit ng `web_fetch` ang Firecrawl

Ang pagkakasunod-sunod ng extraction ng `web_fetch`:

1. Readability (local)
2. Firecrawl (kung naka-configure)
3. Basic HTML cleanup (huling fallback)

Tingnan ang [Web tools](/tools/web) para sa kumpletong setup ng web tool.
