---
summary: "TinyFish web search and fetch provider"
read_when:
  - You want TinyFish-backed web search
  - You need a TinyFish API key
  - You want TinyFish as a web_search provider
  - You want TinyFish as a web_fetch fallback
title: "TinyFish"
---

OpenClaw can use **TinyFish** in two ways:

- as the `web_search` provider
- as a fallback extractor for `web_fetch`

TinyFish is a hosted web search and content extraction service that handles
JS-heavy sites and bot-protected pages.

## Get an API key

1. Create a TinyFish account at [tinyfish.ai](https://tinyfish.ai/) and generate an API key.
2. Store it in config or set `TINYFISH_API_KEY` in the gateway environment.

## Configure TinyFish search

```json5
{
  tools: {
    web: {
      search: {
        provider: "tinyfish",
      },
    },
  },
  plugins: {
    entries: {
      tinyfish: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "TINYFISH_API_KEY_HERE",
          },
        },
      },
    },
  },
}
```

## Configure TinyFish fetch

```json5
{
  tools: {
    web: {
      fetch: {
        provider: "tinyfish",
      },
    },
  },
  plugins: {
    entries: {
      tinyfish: {
        enabled: true,
        config: {
          webFetch: {
            apiKey: "TINYFISH_API_KEY_HERE",
          },
        },
      },
    },
  },
}
```

## Environment variable

Instead of putting the key in config, set the environment variable:

```bash
export TINYFISH_API_KEY=tf_live_...
```

The plugin reads `TINYFISH_API_KEY` as a fallback when no key is configured
in `plugins.entries.tinyfish.config`.

## Custom base URL

To point at a different TinyFish endpoint:

```json5
{
  plugins: {
    entries: {
      tinyfish: {
        enabled: true,
        config: {
          webSearch: {
            baseUrl: "https://custom.tinyfish.ai",
          },
        },
      },
    },
  },
}
```
