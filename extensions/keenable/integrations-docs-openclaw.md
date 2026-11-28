# OpenClaw (Keenable docs source)

Mintlify-ready content for [docs.keenable.ai/integrations/openclaw](https://docs.keenable.ai/integrations/openclaw). Keenable publishes this file; OpenClaw maintains it alongside `@openclaw/keenable-plugin`.

---

````mdx
---
title: OpenClaw
description: Official bundled web_search provider for OpenClaw — same install path as Exa, Firecrawl, and Parallel on the OpenClaw side.
---

> A web-search provider for OpenClaw, installable from ClawHub or npm.

_Search provider plugin_

OpenClaw lists Keenable alongside [Exa](https://docs.openclaw.ai/tools/exa-search), [Firecrawl](https://docs.openclaw.ai/tools/firecrawl), [Parallel](https://docs.openclaw.ai/tools/parallel-search), Tavily, Brave, and other managed providers. The official plugin is **`@openclaw/keenable-plugin`**. It registers provider id `keenable` on the Gateway `web_search` tool and calls `POST https://api.keenable.ai/v1/search` with your API key when configured.

→ [@openclaw/keenable-plugin on npm](https://www.npmjs.com/package/@openclaw/keenable-plugin)  
→ [OpenClaw setup guide](https://docs.openclaw.ai/tools/keenable-search)

<video
  controls
  poster="https://app.keenable.ai/integrations/openclaw.jpg"
  src="https://app.keenable.ai/integrations/openclaw.mp4"
  style={{ width: "100%", borderRadius: "12px" }}
/>

Plugin install, enable, and a first search.

<video
  controls
  poster="https://app.keenable.ai/integrations/openclaw-agent.jpg"
  src="https://app.keenable.ai/integrations/openclaw-agent.mp4"
  style={{ width: "100%", borderRadius: "12px" }}
/>

A live agent turn: `web_search` routes through Keenable and the answer cites its sources.

## Install

### Install the plugin

Install from npm:

```bash
openclaw plugins install @openclaw/keenable-plugin
```
````

Or install from ClawHub:

```bash
openclaw plugins install clawhub:@openclaw/keenable-plugin
```

Restart the Gateway if it does not pick up the plugin automatically. See [Apply changes and inspect](https://docs.openclaw.ai/plugins/manage-plugins#apply-changes-and-inspect) in the OpenClaw docs.

### Select Keenable

In the Control UI, open **Search** and choose **Keenable** as the provider. Or set config:

```json5
{
  tools: {
    web: {
      search: {
        provider: "keenable",
      },
    },
  },
}
```

Requires OpenClaw **2026.6.8** or newer.

### Add an API key

The official OpenClaw plugin uses Keenable’s **authenticated** Search API, so an API
key is required. Signup is free (no credit card): every organization gets
**100,000 free search/fetch requests per month** before paid usage. See
[Pricing](https://keenable.ai/pricing) and [Credits](/credits).

```bash
openclaw configure --section web
```

Or set `KEENABLE_API_KEY` in the Gateway environment (for example `~/.openclaw/.env`). Create a key in the [console](https://app.keenable.ai/console); see [Authentication](/authentication).

<Note>
This plugin does not use Keenable’s keyless public pool (~1,000 req/hour per IP). Use an API key so searches count against your org’s free monthly allowance and [rate limits](/rate-limits) for keyed traffic (10 RPS per org).
</Note>

OpenClaw sends the required `X-Keenable-Title` header on every request (default `OpenClaw`; override with `plugins.entries.keenable.config.webSearch.appTitle`).

### Optional config

```json5
{
  plugins: {
    entries: {
      keenable: {
        config: {
          webSearch: {
            apiKey: "keen_...",
            baseUrl: "https://api.keenable.ai",
            appTitle: "OpenClaw",
          },
        },
      },
    },
  },
}
```

### Try it

Ask your agent a question that needs current web data. `web_search` returns normalized titles, URLs, and snippets (plus optional site and date filters). See the [Search API reference](/api-reference/search) for parameters Keenable exposes at the HTTP layer.

## Same stack as Exa, Firecrawl, and Parallel

On OpenClaw, Exa, Firecrawl, Parallel, and Keenable are all **official search-provider plugins** (`@openclaw/*-plugin`), selected with `tools.web.search.provider`. Keenable is optimized for agent workflows: long snippets, `pro` / `realtime` modes, and publication or index date filters. Pair with the [Keenable MCP server](/mcp-server) when you want search and fetch tools outside OpenClaw’s built-in `web_search`.

| OpenClaw provider | Plugin package               | OpenClaw docs                                                     |
| ----------------- | ---------------------------- | ----------------------------------------------------------------- |
| Exa               | `@openclaw/exa-plugin`       | [Exa search](https://docs.openclaw.ai/tools/exa-search)           |
| Firecrawl         | `@openclaw/firecrawl-plugin` | [Firecrawl](https://docs.openclaw.ai/tools/firecrawl)             |
| Parallel          | `@openclaw/parallel-plugin`  | [Parallel search](https://docs.openclaw.ai/tools/parallel-search) |
| Keenable          | `@openclaw/keenable-plugin`  | [Keenable search](https://docs.openclaw.ai/tools/keenable-search) |

## Legacy `@keenable/openclaw-search`

An earlier third-party plugin (`@keenable/openclaw-search`, ClawHub `keenable/openclaw-search`) registered a Keenable provider before OpenClaw shipped the official bundled plugin. **New installs should use `@openclaw/keenable-plugin`.** The legacy package could call keyless public search endpoints; the official plugin always uses authenticated `/v1/search` with your API key (including the free **100k requests/month** tier).

````

**Integrations index blurb** (for `integrations.md` table row):

```mdx
| [OpenClaw](/integrations/openclaw) | Official `@openclaw/keenable-plugin` — same managed-provider model as Exa and Firecrawl on OpenClaw. |
````
