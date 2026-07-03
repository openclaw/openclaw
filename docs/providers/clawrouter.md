---
summary: "Route credential-scoped models through ClawRouter and show managed quotas"
title: "ClawRouter"
read_when:
  - You want one managed key for multiple model providers
  - You need ClawRouter model discovery or quota reporting in OpenClaw
---

ClawRouter gives OpenClaw one policy-scoped key for multiple upstream model
providers. The bundled plugin discovers only the models allowed for that key,
routes each model through its declared protocol, and reports the key's budget
and aggregate usage on OpenClaw usage surfaces.

| Property      | Value                                    |
| ------------- | ---------------------------------------- |
| Provider      | `clawrouter`                             |
| Package       | `@openclaw/clawrouter`                   |
| Auth          | `CLAWROUTER_API_KEY`                     |
| Default URL   | `https://clawrouter.openclaw.ai`         |
| Model catalog | Credential-scoped via `/v1/catalog`      |
| Quotas        | Monthly budget and usage via `/v1/usage` |

## Getting started

<Steps>
  <Step title="Configure the proxy key">
    ```bash
    export CLAWROUTER_API_KEY="..."
    openclaw onboard --auth-choice clawrouter-api-key
    ```
  </Step>
  <Step title="List granted models">
    ```bash
    openclaw models list --provider clawrouter
    ```

    Model refs retain the upstream namespace, for example
    `clawrouter/openai/gpt-5.5`, `clawrouter/anthropic/claude-sonnet-4-6`, or
    `clawrouter/google/gemini-3.5-flash`.

  </Step>
  <Step title="Select a model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "clawrouter/anthropic/claude-sonnet-4-6" },
        },
      },
    }
    ```
  </Step>
</Steps>

## Protocol and provider plugins

You do not need to install every upstream company's auth plugin. ClawRouter
owns upstream credentials; its catalog tells OpenClaw which transport to use.
The plugin supports:

| Catalog route                  | OpenClaw transport     |
| ------------------------------ | ---------------------- |
| OpenAI-compatible chat         | `openai-completions`   |
| OpenAI-compatible Responses    | `openai-responses`     |
| Native Anthropic Messages      | `anthropic-messages`   |
| Native Google Gemini streaming | `google-generative-ai` |

The plugin also applies the matching replay and tool-schema policies for those
families. Catalog rows using another request/stream format are intentionally
not advertised as OpenClaw text models. Normalize those providers to one of the
supported contracts in ClawRouter rather than sending an incompatible payload.

## Quotas and usage

ClawRouter's `/v1/usage` response feeds the normal OpenClaw provider-usage
surfaces. `/status` and related dashboard status show the monthly budget window
when the key has a limit, plus request, token, and spend totals. Unmetered keys
still show aggregate usage without a percentage window.

Quota lookup uses the same scoped key as model discovery. A failed quota lookup
does not block model execution.

## Security behavior

- Catalog discovery is scoped to the configured proxy key and cached per key.
- The proxy key is attached only at request dispatch; it is not stored in model metadata.
- Native Anthropic and Gemini model ids are rewritten to their upstream ids only at dispatch.
- Unsupported or ungranted catalog rows fail closed and are not selectable.

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Provider configuration and model selection.
  </Card>
  <Card title="Usage tracking" href="/concepts/usage-tracking" icon="chart-line">
    OpenClaw usage and status surfaces.
  </Card>
</CardGroup>
