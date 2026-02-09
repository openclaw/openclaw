---
summary: "Setup ng Brave Search API para sa web_search"
read_when:
  - Gusto mong gamitin ang Brave Search para sa web_search
  - Kailangan mo ng BRAVE_API_KEY o mga detalye ng plano
title: "Brave Search"
---

# Brave Search API

Ginagamit ng OpenClaw ang Brave Search bilang default na provider para sa `web_search`.

## Kumuha ng API key

1. Gumawa ng Brave Search API account sa [https://brave.com/search/api/](https://brave.com/search/api/)
2. Sa dashboard, piliin ang **Data for Search** na plano at bumuo ng API key.
3. I-save ang key sa config (inirerekomenda) o itakda ang `BRAVE_API_KEY` sa Gateway environment.

## Halimbawa ng config

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Mga tala

- Ang Data for AI na plano ay **hindi** compatible sa `web_search`.
- Nagbibigay ang Brave ng libreng tier pati mga bayad na plano; tingnan ang Brave API portal para sa kasalukuyang mga limitasyon.

Tingnan ang [Web tools](/tools/web) para sa kumpletong konpigurasyon ng web_search.
