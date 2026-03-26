---
summary: "Use xAI Grok models in OpenClaw"
read_when:
  - You want to use Grok models in OpenClaw
  - You are configuring xAI auth or model ids
title: "xAI"
---

# xAI

OpenClaw ships a bundled `xai` provider plugin for Grok models.

## Setup

1. Create an API key in the xAI console.
2. Set `XAI_API_KEY`, or run:

```bash
openclaw onboard --auth-choice xai-api-key
```

3. Pick a model such as:

```json5
{
  agents: { defaults: { model: { primary: "xai/grok-4" } } },
}
```

## Current bundled model catalog

OpenClaw now includes these xAI model families out of the box:

- `grok-4`, `grok-4-0709`
- `grok-4-fast-reasoning`, `grok-4-fast-non-reasoning`
- `grok-4-1-fast-reasoning`, `grok-4-1-fast-non-reasoning`
- `grok-4.20-reasoning`, `grok-4.20-non-reasoning`
- `grok-code-fast-1`

The plugin also forward-resolves newer `grok-4*` and `grok-code-fast*` ids when
they follow the same API shape.

## Web search

The bundled `grok` web-search provider uses `XAI_API_KEY` too:

```bash
openclaw config set tools.web.search.provider grok
```

## Image generation

OpenClaw also supports xAI image generation through the shared `image_generate`
tool.

Example config:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "xai/grok-imagine-image",
        fallbacks: ["xai/grok-imagine-image-pro"],
      },
    },
  },
}
```

Notes:

- `xai/grok-imagine-image` is the default bundled image model.
- `xai/grok-imagine-image-pro` is also supported.
- For compatibility with older custom configs, `xai-images/*` model refs keep
  working too.
- If you want separate image credentials from text credentials, configure
  `models.providers.xai-images.apiKey` and point `imageGenerationModel` at
  `xai-images/<model>`.

## Known limits

- Auth is API-key only today. There is no xAI OAuth/device-code flow in OpenClaw yet.
- `grok-4.20-multi-agent-experimental-beta-0304` is not supported on the normal xAI provider path because it requires a different upstream API surface than the standard OpenClaw xAI transport.
- Native xAI server-side tools such as `x_search` and `code_execution` are not yet first-class model-provider features in the bundled plugin.
- xAI image generation follows the current xAI image API surface, including
  aspect-ratio overrides, `1K`/`2K` resolution, and reference-image edits.

## Notes

- OpenClaw applies xAI-specific tool-schema and tool-call compatibility fixes automatically on the shared runner path.
- For the broader provider overview, see [Model providers](/providers/index).
