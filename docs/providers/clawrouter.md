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

You do not install or authenticate each upstream provider plugin on the
OpenClaw host. Upstream credentials and provider-specific forwarding stay in
ClawRouter. OpenClaw needs only the bundled `@openclaw/clawrouter` plugin and an
issued ClawRouter credential.

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
  <Step title="Get a scoped credential">
    Ask your ClawRouter administrator for a credential whose policy includes
    the providers, models, and monthly budget you should use. Credentials are
    revealed once when issued.
  </Step>
  <Step title="Configure OpenClaw">
    ```bash
    export CLAWROUTER_API_KEY="..."
    openclaw onboard --auth-choice clawrouter-api-key
    ```

    The plugin is included with OpenClaw and enabled by default. For a custom
    deployment, set `models.providers.clawrouter.baseUrl` to the ClawRouter
    origin; the default is `https://clawrouter.openclaw.ai`.

  </Step>
  <Step title="List granted models">
    ```bash
    openclaw models list --all --provider clawrouter
    ```

    Use the returned model refs exactly as shown. They retain the upstream
    namespace, such as `clawrouter/openai/...`, `clawrouter/anthropic/...`, or
    `clawrouter/google/...`.

  </Step>
  <Step title="Select a model">
    ```bash
    openclaw models set clawrouter/<provider>/<model>
    ```

    You can also select a returned model for one run with
    `openclaw agent --model clawrouter/<provider>/<model> --message "..."`.

  </Step>
</Steps>

## Model discovery

`GET /v1/catalog` is the source of truth. OpenClaw does not ship a second,
fixed list of ClawRouter models. A model configured in ClawRouter appears when:

- the credential's policy grants its provider;
- the provider connection is enabled and ready;
- the catalog model advertises a supported LLM capability; and
- the catalog exposes a transport contract supported by the plugin.

Adding another model to a supported ClawRouter provider therefore does not
require an OpenClaw release or another provider plugin. The next catalog
refresh discovers it. A model that needs a new wire protocol requires support
in the ClawRouter plugin before OpenClaw advertises it.

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

Check the live snapshot with:

```bash
openclaw status --usage
openclaw models status
```

The same provider snapshot is available to `/status` in chat and OpenClaw's
usage UI. The budget is policy-wide, so requests made by another client using
the same ClawRouter policy can change the remaining percentage.

## Troubleshooting

| Symptom                                  | Check                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| No ClawRouter models                     | Confirm the credential is active, its policy grants at least one ready model provider, and `CLAWROUTER_API_KEY` is available to the OpenClaw process. |
| A configured ClawRouter model is missing | Inspect its `/v1/catalog` capability and route format. Unsupported transport contracts are intentionally filtered.                                    |
| `401` or `403` from catalog or usage     | Reissue or re-scope the ClawRouter credential; OpenClaw does not fall back to upstream provider keys.                                                 |
| Model call fails after discovery         | Check the provider connection and upstream health in ClawRouter, then retry after its readiness state recovers.                                       |
| Usage has totals but no percentage       | The policy is unmetered; add a monthly budget in ClawRouter to expose a percentage window.                                                            |

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
