---
summary: "Runware setup (API key, live model discovery, request quirks)"
title: "Runware"
read_when:
  - You want to use Runware with OpenClaw
  - You want to know how Runware's model catalog is discovered
---

[Runware](https://runware.ai) exposes an OpenAI-compatible chat completions API
in front of a live-updated catalog of hosted models (DeepSeek, Kimi, GLM, Grok,
Gemma, MiniMax, Qwen, and more).

| Property | Value                       |
| -------- | --------------------------- |
| Provider | `runware`                   |
| API      | OpenAI-compatible           |
| Base URL | `https://api.runware.ai/v1` |
| Auth     | API key                     |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create a key at [my.runware.ai/api-keys](https://my.runware.ai/api-keys).
  </Step>
  <Step title="Run onboarding or set the env var directly">
    ```bash
    openclaw onboard --auth-choice runware-api-key
    ```

    Or:

    ```bash
    export RUNWARE_API_KEY="your-key"
    ```

  </Step>
  <Step title="Set a model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "runware/deepseek-v4-flash" },
        },
      },
    }
    ```

  </Step>
</Steps>

## Model discovery (no manual catalog)

Runware's model list is **not** hand-maintained in this plugin. On every
catalog refresh, OpenClaw calls:

```
GET https://api.runware.ai/v1/models
```

and maps each returned row — id, context length, max output tokens, input
modalities, and per-token pricing — directly into an OpenClaw model entry.
There is no bundled per-model table to fall out of date. `agents.defaults.models`
allows `"runware/*"` by default so newly-added Runware models become usable
immediately, with no plugin update required.

`GET /v1/models` requires authentication, so `openclaw models list --all`
(run before any API key is configured) shows a single illustrative
placeholder rather than the real catalog. Once `RUNWARE_API_KEY` is set, the
real live catalog takes over.

<Note>
Runware does not currently expose a reasoning-capability field in `/v1/models`.
Every discovered model defaults to `reasoning: false` until that changes;
misreporting a non-reasoning model as reasoning-capable would incorrectly
alter prompt-building and thinking-UI behavior.
</Note>

## Request compatibility fixes

OpenClaw's Runware plugin patches two request-shaping quirks in Runware's
chat completions endpoint before dispatch:

- **`max_tokens`**: Runware's server-side default can exceed a given model's
  real completion-token cap. OpenClaw always sends an explicit `max_tokens`,
  clamped to that model's live-discovered cap.
- **Empty tool schemas**: Runware rejects the zero-argument tool shape
  (`{"type":"object","properties":{}}`) that OpenClaw normally sends for
  parameter-less tools. OpenClaw adds a harmless placeholder property to any
  tool schema with no properties before sending the request.

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Provider directory" href="/providers/index" icon="list">
    All supported model providers.
  </Card>
</CardGroup>
