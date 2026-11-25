---
summary: "Connect Liquid Inference as a custom OpenAI-compatible provider"
title: "Liquid Inference"
read_when:
  - You want to use Liquid Inference with OpenClaw
  - You want to configure a per-request price cap
---

[Liquid Inference](https://inference.ai.exchange) is an inference exchange with an
OpenAI-compatible endpoint. Configure it with OpenClaw's existing custom-provider
support and the `openai-completions` API.

| Property    | Value                                       |
| ----------- | ------------------------------------------- |
| Provider id | `liquid` (custom)                           |
| Auth        | Liquid Inference API key with `spend` scope |
| API         | `openai-completions`                        |
| Base URL    | `https://router.inference.ai.exchange/v1`   |

## Quick start

<Steps>
  <Step title="Create a key">
    Sign in at [inference.ai.exchange](https://inference.ai.exchange), add credit to
    your workspace, and create an API key with the `spend` scope. Export it in the
    shell you use for the next steps:

    ```bash
    export LIQUID_API_KEY="example-liquid-key-not-real"
    ```

  </Step>
  <Step title="Configure the provider">
    Merge this block into your `openclaw.json`. Keep the `/v1` suffix in `baseUrl`:
    the OpenAI client appends `chat/completions`.

    ```json5
    {
      models: {
        providers: {
          liquid: {
            baseUrl: "https://router.inference.ai.exchange/v1",
            api: "openai-completions",
            headers: {
              "X-Title": "OpenClaw",
              "x-liquid-cap-usd": "1.00",
            },
            models: [
              {
                id: "liquid.auto",
                name: "liquid.auto",
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    }
    ```

  </Step>
  <Step title="Save the key">
    ```bash
    printf '%s\n' "$LIQUID_API_KEY" | openclaw models auth paste-api-key --provider liquid --agent main
    ```

    With the custom provider configured, this stores the key in OpenClaw's shared
    credential store and binds the provider to it. The key does not need to stay in
    the Gateway service's environment. If the command reports that the Gateway has
    not applied the settings, restart the Gateway before testing.

  </Step>
  <Step title="Select and test the model">
    ```bash
    openclaw models set liquid/liquid.auto
    openclaw agent exec --cwd . --model liquid/liquid.auto "Reply with the word ready"
    ```

  </Step>
</Steps>

## Models

The model `id` is sent to the exchange unchanged. `liquid.auto` lets the exchange
choose a model for each request. To list the current model names:

```bash
curl https://router.inference.ai.exchange/v1/models
```

Add a `models` entry for each name you want to select. Set `contextWindow` and
`maxTokens` to limits supported by that model and the offers you use; OpenClaw
uses the context window when deciding when to compact a session.

## Request headers and spending

| Header             | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `X-Title`          | Identifies OpenClaw on Liquid Inference receipts. |
| `x-liquid-cap-usd` | Maximum charge for one request, in USD.           |

The configured headers accompany requests to this provider, including compaction
requests. A turn can make several requests, so a per-request cap does not cap the
whole turn's cost. Use the key's spend limit to bound total spending.

To change the per-request cap:

```bash
openclaw config set models.providers.liquid.headers.x-liquid-cap-usd '"0.25"' --strict-json
```

## Errors and fallback models

OpenClaw applies its normal retry, credential cooldown, and model-fallback behavior.
See [Model failover](/concepts/model-failover), including
[Billing disables](/concepts/model-failover#billing-disables) for `402` responses.

A fallback at another provider can answer a refused request and bill you there.
If you want requests to remain on Liquid Inference, use only `liquid/` fallback
models or clear the fallback list:

```bash
openclaw config set agents.defaults.model.fallbacks '[]' --strict-json
```

| Symptom                          | Check                                                                     |
| -------------------------------- | ------------------------------------------------------------------------- |
| `401`                            | Save a valid key with the command above.                                  |
| `402`                            | Check workspace credit and the key's spend limit, then billing cooldowns. |
| `404`                            | Keep `/v1` at the end of `baseUrl`.                                       |
| `no_eligible_offer`              | Inspect `eligibility.excluded` in the error response.                     |
| No receipt for a successful turn | Check whether a fallback at another provider answered.                    |

See [Model providers](/concepts/model-providers) for custom-provider configuration
and [Models](/concepts/models) for model selection.
