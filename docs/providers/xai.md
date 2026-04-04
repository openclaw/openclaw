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

OpenClaw now uses the xAI Responses API as the bundled xAI transport. The same
`XAI_API_KEY` can also power Grok-backed `web_search`, first-class `x_search`,
and remote `code_execution`.
If you store an xAI key under `plugins.entries.xai.config.webSearch.apiKey`,
the bundled xAI model provider now reuses that key as a fallback too.
`code_execution` tuning lives under `plugins.entries.xai.config.codeExecution`.

## Current bundled model catalog

OpenClaw now includes these xAI model families out of the box:

- `grok-3`, `grok-3-fast`, `grok-3-mini`, `grok-3-mini-fast`
- `grok-4`, `grok-4-0709`
- `grok-4-fast`, `grok-4-fast-non-reasoning`
- `grok-4-1-fast`, `grok-4-1-fast-non-reasoning`
- `grok-4.20-beta-latest-reasoning`, `grok-4.20-beta-latest-non-reasoning`
- `grok-code-fast-1`

The plugin also forward-resolves newer `grok-4*` and `grok-code-fast*` ids when
they follow the same API shape.

Legacy compatibility aliases still normalize to the canonical bundled ids. For
example:

- `grok-4-fast-reasoning` -> `grok-4-fast`
- `grok-4-1-fast-reasoning` -> `grok-4-1-fast`
- `grok-4.20-reasoning` -> `grok-4.20-beta-latest-reasoning`
- `grok-4.20-non-reasoning` -> `grok-4.20-beta-latest-non-reasoning`

## Web search

The bundled `grok` web-search provider uses `XAI_API_KEY` too:

```bash
openclaw config set tools.web.search.provider grok
```

## Known limits

- Auth is API-key only today. There is no xAI OAuth/device-code flow in OpenClaw yet.
- `grok-4.20-multi-agent-experimental-beta-0304` is not supported on the normal xAI provider path because it requires a different upstream API surface than the standard OpenClaw xAI transport.

## Notes

- OpenClaw applies xAI-specific tool-schema and tool-call compatibility fixes automatically on the shared runner path.
- `web_search`, `x_search`, and `code_execution` are exposed as OpenClaw tools. OpenClaw enables the specific xAI built-in it needs inside each tool request instead of attaching all native tools to every chat turn.
- `x_search` and `code_execution` are owned by the bundled xAI plugin rather than hardcoded into the core model runtime.
- `code_execution` is remote xAI sandbox execution, not local [`exec`](/tools/exec).
- For the broader provider overview, see [Model providers](/providers/index).
