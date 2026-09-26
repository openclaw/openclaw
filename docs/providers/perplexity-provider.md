---
summary: "Perplexity web search provider setup (API key, search modes, filtering)"
title: "Perplexity"
read_when:
  - You want to configure Perplexity as a web search provider
  - You need the Perplexity API key or OpenRouter proxy setup
---

The Perplexity plugin registers a `web_search` provider with two transports: the
native Perplexity Search API (structured results with filters) and Perplexity
Sonar chat completions, direct or via OpenRouter (AI-synthesized answers with
citations).

<Note>
This page covers the Perplexity **web search provider** setup. For the Perplexity **tool** (how the agent uses it), see [Perplexity search](/tools/perplexity-search). To use the Perplexity **Agent API** as an LLM model provider, see [Perplexity Agent API](/providers/perplexity-agent-api).
</Note>

| Property    | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Type        | Web search provider (not a model provider)                             |
| Auth        | `PERPLEXITY_API_KEY` (native) or `OPENROUTER_API_KEY` (via OpenRouter) |
| Config path | `plugins.entries.perplexity.config.webSearch.apiKey`                   |
| Overrides   | `plugins.entries.perplexity.config.webSearch.baseUrl` / `.model`       |
| Get a key   | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)   |

## Install plugin

```bash
openclaw plugins install @openclaw/perplexity-plugin
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Getting started

<Steps>
  <Step title="Set the API key">
    ```bash
    openclaw configure --section web
    ```

    Or set the key directly:

    ```bash
    openclaw config set plugins.entries.perplexity.config.webSearch.apiKey "pplx-xxxxxxxxxxxx"
    ```

    A key exported as `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY` in the Gateway
    environment also works.

  </Step>
  <Step title="Start searching">
    `web_search` auto-detects Perplexity once its key is the available search
    credential; no further setup is required. To pin the provider explicitly:

    ```bash
    openclaw config set tools.web.search.provider perplexity
    ```

  </Step>
</Steps>

## Search modes

The plugin resolves transport in this order:

1. `webSearch.baseUrl` or `webSearch.model` set: always routes through Sonar chat completions against that endpoint, regardless of key type.
2. Otherwise, key source decides the endpoint: a configured key's prefix picks the transport (config beats environment variables); an environment key uses its matching endpoint directly.

| Key prefix | Transport                                                  | Features                                         |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `pplx-`    | Native Perplexity Search API (`https://api.perplexity.ai`) | Structured results, domain/language/date filters |
| `sk-or-`   | OpenRouter (`https://openrouter.ai/api/v1`), Sonar model   | AI-synthesized answers with citations            |

A configured key with any other prefix also uses the native Search API. The
chat-completions path defaults to the `perplexity/sonar-pro` model; override it
with `plugins.entries.perplexity.config.webSearch.model`.

### Direct Sonar transition

OpenClaw's current direct synthesized-answer path sends synchronous
`POST https://api.perplexity.ai/chat/completions` requests. It does not use
Perplexity's separate `/v1/async/sonar` endpoints. Agent API uses
`POST /v1/agent`, with `POST /v1/responses` as its OpenAI Responses alias.

Perplexity's public migration guide says Sonar Chat Completions remains supported
and recommends Agent API for new integrations. It does not publish a September
27 cutoff or automatic-routing contract for synchronous requests. In a private
September 24 confirmation relayed by this PR's author, Perplexity's API owner
said selecting Sonar for non-async requests will continue after September 27,
2026 through automatic server-side routing to an Agent API preset, while the
async Sonar endpoints will fully discontinue. This future policy is not
independently verifiable from the public migration pages or observable in
OpenClaw's current transport; operators who require a public contract should
follow the published migration guidance. Automatic routing would preserve
request continuity, not identical parameters, results, latency, pricing, or
features.

## Native API filtering

| Filter                               | Description                                                                             | Transport   |
| ------------------------------------ | --------------------------------------------------------------------------------------- | ----------- |
| `count`                              | Results per search, 1-10 (default 5); accepted but ignored on the chat-completions path | Both        |
| `freshness`                          | Recency window: `day`, `week`, `month`, `year`                                          | Both        |
| `country`                            | 2-letter country code (`us`, `de`, `jp`)                                                | Native only |
| `language`                           | ISO 639-1 language code (`en`, `fr`, `zh`)                                              | Native only |
| `date_after` / `date_before`         | Published-date range in `YYYY-MM-DD`                                                    | Native only |
| `domain_filter`                      | Max 20 domains; allowlist or `-`-prefixed denylist, never mixed                         | Native only |
| `max_tokens` / `max_tokens_per_page` | Content budget across all results / per page; `max_tokens` max 1000000                  | Native only |

In chat-completions mode, the generated `web_search` tool schema omits the seven
native-only filter properties, so agents cannot request them through the tool.
If a caller bypasses that schema and supplies one directly, the runtime returns
a descriptive unsupported-option error. `freshness` cannot be combined with
`date_after`/`date_before`.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Environment variable for daemon processes">
    <Warning>
    A key exported only in an interactive shell is not visible to a
    launchd/systemd Gateway daemon unless that environment is explicitly
    imported. Set the key in `~/.openclaw/.env` or via `env.shellEnv` so the
    Gateway process can read it. See [Environment variables](/help/environment)
    for the full precedence order.
    </Warning>
  </Accordion>

  <Accordion title="OpenRouter compatibility">
    To route Perplexity searches through OpenRouter, set an `OPENROUTER_API_KEY`
    (prefix `sk-or-`) instead of a native Perplexity key. OpenClaw currently
    detects the key and uses OpenRouter's chat-completions endpoint.

    OpenRouter is a third-party transport. Perplexity's direct, non-async Sonar
    continuity does not guarantee OpenRouter model availability or future
    behavior. Check [OpenRouter's Perplexity catalog](https://openrouter.ai/perplexity)
    for the models and lifecycle that OpenRouter currently offers.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={3}>
  <Card title="Perplexity search tool" href="/tools/perplexity-search" icon="magnifying-glass">
    How the agent invokes Perplexity searches and interprets results.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full configuration reference including plugin entries.
  </Card>
  <Card title="Perplexity Agent API" href="/providers/perplexity-agent-api" icon="robot">
    Use Agent API as an OpenClaw LLM model provider.
  </Card>
</CardGroup>
