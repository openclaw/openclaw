---
summary: "Staan search -- independent European web index with scored passages"
read_when:
  - You want to use Staan for web_search
  - You need a STAAN_API_KEY
  - You need an EU-jurisdiction search provider
title: "Staan search"
---

[Staan](https://staan.ai/) is a `web_search` provider. It is an independent
European web index built on the same search stack as Qwant, operated by
European Search Perspective under EU jurisdiction, and it returns source-cited
results with optional relevance-scored passages and full page extraction.

## Install plugin

```bash
openclaw plugins install @openclaw/staan-plugin
openclaw gateway restart
```

## Get an API key

<Steps>
  <Step title="Create an account">
    Sign up at [staan.ai](https://staan.ai/) and generate an API key. The free
    tier includes 1,000 requests per month.
  </Step>
  <Step title="Store the key">
    Set `STAAN_API_KEY` in the Gateway environment, or configure via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## Config

```json5
{
  plugins: {
    entries: {
      staan: {
        config: {
          webSearch: {
            apiKey: "stn_...", // optional if STAAN_API_KEY is set
            market: "fr-fr", // optional default market
            baseUrl: "https://api.staan.ai/v2", // optional; OpenClaw appends /search/web
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "staan",
      },
    },
  },
}
```

## Parameters

| Parameter         | Type     | Notes                                                                        |
| ----------------- | -------- | ---------------------------------------------------------------------------- |
| `query`           | string   | Required.                                                                    |
| `count`           | integer  | 1-10. Staan pages are fixed at 10; smaller values trim the page client-side. |
| `offset`          | integer  | Pagination offset, in multiples of 10.                                       |
| `market`          | string   | One of the [markets](#markets) below.                                        |
| `extra_snippets`  | boolean  | Return relevance-scored passages per result.                                 |
| `max_snippets`    | integer  | 1-10. Only applies with `extra_snippets`.                                    |
| `min_score`       | number   | 0-1. Drops passages below this score.                                        |
| `full_content`    | string   | `markdown` or `html`. Returns full page bodies.                              |
| `include_domains` | string[] | Restrict to these domains, max 10.                                           |
| `exclude_domains` | string[] | Exclude these domains, max 10.                                               |

## Markets

`en-gb`, `en-us`, `en-au`, `en-ca`, `en-ie`, `en-in`, `en-nz`, `en-sg`,
`en-za`, `en-fr`, `fr-fr`, `de-de`.

<Warning>
  Staan's public documentation lists `en-uk`, but the API rejects it with a
  `400`. Use `en-gb`.
</Warning>

## Scored passages

`extra_snippets` returns ranked passages from each page alongside the standard
snippet, which is what you want when an answer has to be attributable to a
specific piece of source text:

```json5
{
  query: "vacation rental regulations portugal",
  extra_snippets: true,
  max_snippets: 5,
  min_score: 0.2,
}
```

Each result then carries a `snippets` array of `{ text, score }` entries,
ordered by relevance.

## Notes

- Result pages are fixed at 10. `count` trims locally; use `offset` to page.
- Supported content languages are French, English and German.
- Responses are treated as untrusted external content and wrapped accordingly,
  the same as every other `web_search` provider.

## See also

<CardGroup cols={2}>
  <Card title="Web search" href="/tools/web" icon="globe">
    Provider selection and shared search config.
  </Card>
  <Card title="Brave Search" href="/tools/brave-search" icon="lion">
    Independent index with an API-key tier.
  </Card>
</CardGroup>
