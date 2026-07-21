---
summary: "Ace Data Cloud unified provider for chat + web search in OpenClaw"
title: "Ace Data Cloud"
read_when:
  - You want one API key for 60+ LLMs across Claude / GPT / Gemini / Grok / DeepSeek / Kimi / GLM
  - You want OpenClaw web search via Google SERP without a separate provider
  - You want to use Ace Data Cloud as the default model provider
---

[Ace Data Cloud](https://platform.acedata.cloud) is a unified, OpenAI-compatible AI gateway. The `acedatacloud` plugin exposes its chat catalog (60+ curated models plus arbitrary upstream model-id passthrough) and its Google SERP web search through OpenClaw's standard provider contracts.

| Property        | Value                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Provider id     | `acedatacloud`                                                                                     |
| Plugin package  | [`@acedatacloud/openclaw-provider`](https://www.npmjs.com/package/@acedatacloud/openclaw-provider) |
| Auth env vars   | `ACEDATA_API_KEY`, `ACEDATACLOUD_API_KEY`                                                          |
| Onboarding flag | `--auth-choice acedatacloud-api-key`                                                               |
| Direct CLI flag | `--acedata-api-key <key>`                                                                          |
| Endpoint        | `https://api.acedata.cloud/v1` (OpenAI-compatible)                                                 |
| Web-search      | Google SERP (search, images, news, videos, maps, places)                                           |
| Source          | <https://github.com/AceDataCloud/OpenClawProvider>                                                 |

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [platform.acedata.cloud](https://platform.acedata.cloud).
  </Step>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install '@acedatacloud/openclaw-provider'
    openclaw gateway restart
    ```
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice acedatacloud-api-key
    ```
  </Step>
  <Step title="Set Ace Data Cloud as the default model provider">
    ```bash
    openclaw models set acedatacloud/claude-opus-4-8
    ```
  </Step>
</Steps>

## Config example

```json5
{
  env: { ACEDATA_API_KEY: "ace-..." },
  agents: {
    defaults: {
      model: { primary: "acedatacloud/claude-opus-4-8" },
    },
  },
}
```

## Model references

Model refs follow the pattern `acedatacloud/<model-name>`. The plugin ships with a curated catalog and also accepts arbitrary upstream model ids as a passthrough — anything Ace Data Cloud lists at [docs.acedata.cloud/aichat/models](https://docs.acedata.cloud/aichat/models) is valid.

Examples (all current as of 2026-05):

| Model ref                                | Notes                              |
| ---------------------------------------- | ---------------------------------- |
| `acedatacloud/claude-opus-4-8`           | Anthropic Claude Opus 4.8 (latest) |
| `acedatacloud/claude-sonnet-4-6`         | Anthropic Claude Sonnet 4.6        |
| `acedatacloud/claude-haiku-4-5-20251001` | Anthropic Claude Haiku 4.5         |
| `acedatacloud/gpt-5.2-pro`               | OpenAI GPT-5.2 Pro                 |
| `acedatacloud/gpt-5.4-mini`              | OpenAI GPT-5.4 Mini                |
| `acedatacloud/o4-mini`                   | OpenAI o4-mini reasoning           |
| `acedatacloud/gemini-3.1-pro`            | Google Gemini 3.1 Pro              |
| `acedatacloud/grok-4-1-fast`             | xAI Grok 4.1 Fast                  |
| `acedatacloud/deepseek-v4-flash`         | DeepSeek V4 Flash                  |
| `acedatacloud/kimi-k2.5`                 | Moonshot Kimi K2.5                 |
| `acedatacloud/glm-5.1`                   | Zhipu GLM-5.1                      |

## Web search

The plugin also registers `acedatacloud` as a web-search provider. It reuses the chat API key and submits queries to `https://api.acedata.cloud/serp/google` across six verticals: `search`, `images`, `news`, `videos`, `maps`, `places`.

```bash
openclaw config set tools.web.search.provider acedatacloud
openclaw config set tools.web.search.enabled true
```

Or override the search key independently:

```json5
{
  plugins: {
    entries: {
      acedatacloud: {
        config: {
          webSearch: {
            apiKey: "ace-...", // optional override
            baseUrl: "https://api.acedata.cloud", // optional override
          },
        },
      },
    },
  },
}
```

## Authentication

The plugin reads credentials in this order:

1. `models.providers.acedatacloud.apiKey` in `openclaw.json`
2. `ACEDATA_API_KEY`
3. `ACEDATACLOUD_API_KEY`

All requests use `Authorization: Bearer <key>` against the Ace Data Cloud OpenAI-compatible endpoint.

## Related

<CardGroup cols={2}>
  <Card title="Models concepts" href="/concepts/models" icon="brain">
    How OpenClaw resolves model refs and provider selection.
  </Card>
  <Card title="Web search" href="/tools/web" icon="magnifying-glass">
    The shared web-search tool contract used by Ace Data Cloud's SERP provider.
  </Card>
</CardGroup>
