---
summary: "Use Standard Compute's OpenAI-compatible routing gateway with OpenClaw"
read_when:
  - You want to use Standard Compute models in OpenClaw
  - You need the Standard Compute base URL, API key env var, or model refs
title: "Standard Compute"
---

[Standard Compute](https://stdcmpt.com) is an OpenAI-compatible model gateway.
The `standardcompute` model routes each step to the cheapest capable model
across its vetted providers and falls back automatically when a provider fails.
Catalog model IDs from `GET /v1/models` are also available.

| Property      | Value                                                          |
| ------------- | -------------------------------------------------------------- |
| Provider      | `standardcompute`                                              |
| Auth          | `STANDARDCOMPUTE_API_KEY`                                      |
| API           | OpenAI-compatible (`openai-completions`)                       |
| Base URL      | `https://api.stdcmpt.com/v1` (US: `https://us.stdcmpt.com/v1`) |
| Model catalog | `GET /v1/models`; default model ID `standardcompute`           |

<Note>
Standard Compute is a third-party gateway. OpenClaw does not bundle a provider
plugin for it; register it as a custom provider as shown below. Compliance
routing and the no-training/no-prompt-storage policy are vendor features — see
Standard Compute's documentation for the current terms.
</Note>

## Setup

<Steps>
  <Step title="Create an API key">
    Create a key in the Standard Compute dashboard and copy it.
  </Step>
  <Step title="Export the key">
    ```bash
    export STANDARDCOMPUTE_API_KEY="<your-standard-compute-key>"
    ```

    If the Gateway runs as a daemon, put the variable in `~/.openclaw/.env` or
    expose it through `env.shellEnv` so the service can read it.

  </Step>
  <Step title="Register the provider">
    ```json5
    {
      models: {
        mode: "merge",
        providers: {
          standardcompute: {
            baseUrl: "https://api.stdcmpt.com/v1",
            api: "openai-completions",
            apiKey: "${STANDARDCOMPUTE_API_KEY}",
            models: [
              {
                id: "standardcompute",
                name: "Standard Compute (auto)",
                input: ["text"],
              },
            ],
          },
        },
      },
      agents: { defaults: { model: "standardcompute/standardcompute" } },
    }
    ```
  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider standardcompute
    ```

    `models list` shows the inventory you configured. To confirm what the key can
    call, request the catalog directly:

    ```bash
    curl -s https://api.stdcmpt.com/v1/models \
      -H "Authorization: Bearer $STANDARDCOMPUTE_API_KEY"
    ```

  </Step>
</Steps>

Use the US endpoint `https://us.stdcmpt.com/v1` when your account is pinned to
that region.

## Models

| Model ref                         | Notes                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `standardcompute/standardcompute` | Automatic routing across providers; the default model ID.                                                  |
| `standardcompute/<catalog-id>`    | Any model ID returned by your key's `GET /v1/models`. Add a row for each ID you want to select explicitly. |

The gateway picks the hosting provider for the automatic model, so a single
model ref can resolve to different upstream models over time. Pin a catalog ID
when you need a specific model for a task.

## Troubleshooting

- **`401` or `403`** — confirm `STANDARDCOMPUTE_API_KEY` is visible to the
  Gateway process and that the key is allowed to call the selected model ID.
- **Model not listed** — `models list` reflects configured inventory; check the
  authenticated `/v1/models` response and add a row for the catalog ID.
- **Region-specific account** — switch `baseUrl` to the US endpoint.
