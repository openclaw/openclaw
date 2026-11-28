---
summary: "Use JZS Token (JZSTOKEN) OpenAI-compatible models with OpenClaw"
read_when:
  - You want to use JZSTOKEN models in OpenClaw
  - You need the JZSTOKEN base URL, API key env var, or model refs
title: "JZS Token (JZSTOKEN)"
---

[JZS Token](https://jzstoken.com) exposes an OpenAI-compatible Chat Completions
API, so you can register it as a custom provider without installing a plugin.

| Property | Value                         |
| -------- | ----------------------------- |
| Provider | `jzstoken`                    |
| Auth     | `JZSTOKEN_API_KEY`            |
| API      | `openai-completions`          |
| Base URL | `https://jzstoken.com/api/v1` |

<Note>
JZSTOKEN issues model-specific keys. A **Standard** key covers most models; its
own flagship `jzs-max-3.0` requires a dedicated key. `openclaw models list` shows
the models you configured or that are published in inventory; it cannot prove a
credential can call them. Verify access with an authenticated request to the
vendor endpoint:

```bash
curl -s https://jzstoken.com/api/v1/models \
  -H "Authorization: Bearer $JZSTOKEN_API_KEY"
```

</Note>

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an account, add credit, then create a key at
    [jzstoken.com/dashboard/keys](https://jzstoken.com/dashboard/keys).
  </Step>
  <Step title="Export the key">
    ```bash
    export JZSTOKEN_API_KEY="sk-..."
    ```

    If the Gateway runs as a daemon, put the variable in `~/.openclaw/.env` or
    expose it through `env.shellEnv` so the service can read it.

  </Step>
  <Step title="Register the provider">
    Add a custom provider to your config:

    ```json5
    {
      models: {
        mode: "merge",
        providers: {
          jzstoken: {
            baseUrl: "https://jzstoken.com/api/v1",
            api: "openai-completions",
            apiKey: "${JZSTOKEN_API_KEY}",
            models: [
              {
                id: "gpt-5.6-terra",
                name: "GPT-5.6 Terra",
                input: ["text"],
              },
            ],
          },
        },
      },
    }
    ```

  </Step>
  <Step title="Select a model">
    `models list` reports the inventory you configured; confirm the key can
    call it with the authenticated `/v1/models` request from the note above.

    ```bash
    openclaw models list --provider jzstoken
    openclaw config set agents.defaults.model "jzstoken/gpt-5.6-terra"
    ```

    To use the flagship, create the dedicated `jzs-max-3.0` key, add that model
    row to the provider's `models` array, and set `jzstoken/jzs-max-3.0`.

  </Step>
</Steps>

## Models

| Model ref                | Notes                                                                       |
| ------------------------ | --------------------------------------------------------------------------- |
| `jzstoken/jzs-max-3.0`   | JZS Token's flagship aggregated endpoint. 1M context, text and image input. |
| `jzstoken/gpt-5.6-terra` | Upstream model routed by JZS Token; availability depends on the key type.   |

The vendor publishes live IDs and per-model limits on its
[model catalog](https://jzstoken.com/model-pricing). Only models returned by your
key's `GET /v1/models` are callable.

## Pricing

`jzs-max-3.0` is billed at `$0` through November 30, 2026 (UTC). Standard rates
after the promotion are $0.0778 per 1M input tokens, $0.3892 per 1M output
tokens, and $0.0078 per 1M cache-read tokens. Treat the vendor
[pricing page](https://jzstoken.com/model-pricing) as authoritative; OpenClaw
does not seed local cost estimates for this custom provider.

## Troubleshooting

- **`401` or `403` on a model you expect** — the key type does not cover it.
  Confirm with `GET /v1/models` using that key, then create the dedicated key the
  vendor requires or choose a model the key can access.
- **`openclaw models list` is empty** — that list is configured inventory, not an
  access check. Confirm `baseUrl` ends in `/api/v1` and that
  `JZSTOKEN_API_KEY` is visible to the process that runs the Gateway.
- **Images rejected** — only models that advertise image input accept them; the
  transport itself is `openai-completions`.
