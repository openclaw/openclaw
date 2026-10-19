---
summary: "Use Abstract's hosted GLM-5.3, DeepSeek-V4-Flash and Kimi-K3 models in OpenClaw through the Responses API"
title: "Abstract"
read_when:
  - You want to run OpenClaw on GLM-5.3, DeepSeek-V4-Flash or Kimi-K3 through Abstract
  - You need the models.providers entry, model IDs and token prices for Abstract
---

[Abstract](https://abstract.inc) serves open-weight LLMs through an OpenAI-compatible API at
`https://api.abstract.inc/v1`. Its `:superfast` models stream over the OpenAI Responses API, so
OpenClaw talks to Abstract over the `openai-responses` transport.

| Property    | Value                                                            |
| ----------- | ---------------------------------------------------------------- |
| Provider id | `abstract` (custom; configure under `models.providers.abstract`) |
| Plugin      | none; not a bundled OpenClaw provider plugin                     |
| Auth        | Abstract API key, sent as a bearer token                         |
| API         | `openai-responses`                                               |
| Base URL    | `https://api.abstract.inc/v1`                                    |

<Note>
  Abstract is a custom provider, not a bundled OpenClaw provider plugin. `openclaw onboard` offers
  no Abstract auth choice, so you write the `models.providers.abstract` entry yourself.
</Note>

## Quick start

<Steps>
  <Step title="Get an API key">
    Install the `abstract` CLI and sign in, then put the key in your environment:

    ```bash
    curl -fsSL https://abstract.inc/install.sh | bash
    abstract login
    export ABSTRACT_API_KEY="$(abstract token)"
    ```

    You can also create a key on the [API keys](https://platform.abstract.inc/keys) page of
    Abstract Platform. Requests draw on prepaid API credit, which you buy in
    [Platform Billing](https://platform.abstract.inc/billing).

  </Step>
  <Step title="Add the provider to your config">
    Copy the [Configuration](#configuration) block below into your OpenClaw config. The key is read
    from `ABSTRACT_API_KEY`, so the process that runs OpenClaw, including a Gateway service, needs
    that variable set.
  </Step>
  <Step title="Select a model">
    ```bash
    openclaw models set abstract/glm-5.3:superfast
    openclaw models list --provider abstract
    ```

    `openclaw models set` recognizes the provider only after the `models.providers.abstract` entry
    exists. Keep the `:superfast` suffix: it is part of the model ID.

  </Step>
</Steps>

## Configuration

```json5
{
  models: {
    providers: {
      abstract: {
        baseUrl: "https://api.abstract.inc/v1",
        apiKey: "${ABSTRACT_API_KEY}",
        api: "openai-responses",
        models: [
          {
            id: "glm-5.3:superfast",
            name: "GLM-5.3 (Abstract)",
            reasoning: true,
            input: ["text"],
            cost: { input: 1.19, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 65536,
          },
          {
            id: "deepseek-v4-flash:superfast",
            name: "DeepSeek-V4-Flash (Abstract)",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.1, output: 0.25, cacheRead: 0.05, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 65536,
          },
          {
            id: "kimi-k3:superfast",
            name: "Kimi-K3 (Abstract)",
            reasoning: true,
            input: ["text"],
            cost: { input: 3, output: 12.75, cacheRead: 0.3, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "abstract/glm-5.3:superfast" },
    },
  },
}
```

Because `api.abstract.inc` is a public HTTPS endpoint, you do not need a private-network override.

## Models

| Model ID                      | Input ($/M tokens) | Cached input ($/M tokens) | Output ($/M tokens) |
| ----------------------------- | ------------------ | ------------------------- | ------------------- |
| `glm-5.3:superfast`           | 1.19               | 0.26                      | 4.40                |
| `deepseek-v4-flash:superfast` | 0.10               | 0.05                      | 0.25                |
| `kimi-k3:superfast`           | 3.00               | 0.30                      | 12.75               |

OpenClaw reads `cost` in USD per million tokens, so these rates drop into the config as written.
Abstract reports `input_tokens`, `input_tokens_details.cached_tokens` and `output_tokens` on every
finished response, and OpenClaw maps cached tokens to `cacheRead`, so the cost OpenClaw records
matches the per-model rates above. Abstract fixes a request's rates when you submit it.

To list the model IDs your key can reach:

```bash
curl https://api.abstract.inc/v1/models \
  -H "Authorization: Bearer $ABSTRACT_API_KEY"
```

## Limits and behavior

<AccordionGroup>
  <Accordion title="Output tokens and credit reservation">
    Abstract accepts at most 65,536 output tokens per request, which is the `maxTokens` value in the
    config above. Before a request runs, Abstract reserves its maximum cost against your prepaid
    credit, so a large `maxTokens` needs more available credit. If requests fail with
    `insufficient_credit`, buy more credit or lower `maxTokens` on the model entry.
  </Accordion>

  <Accordion title="Context window and request size">
    Abstract does not publish a context window for these models. The config uses `262144` as a
    working value. The API refuses request bodies larger than 2 MiB, so a very long session can hit
    that limit first; set `contextTokens` on a model entry to have OpenClaw compact earlier.
  </Accordion>

  <Accordion title="Text input only">
    The models take text input only, so keep `input: ["text"]`. OpenClaw then does not attach images
    to turns that use these models.
  </Accordion>

  <Accordion title="Unsupported Responses fields">
    Abstract refuses `store: true`, `background: true` and `previous_response_id` on these models with
    HTTP 422 `invalid_request`, before it reserves any cost. The configuration above works within these
    limits; do not set `compat.supportsStore` on these models.
  </Accordion>

  <Accordion title="Common errors">
    | HTTP | Code                   | What to do                                                               |
    | ---- | ---------------------- | ------------------------------------------------------------------------ |
    | 401  | `invalid_api_key`      | Run `abstract login` again and refresh `ABSTRACT_API_KEY`.               |
    | 402  | `payment_required`     | Buy credit in [Platform Billing](https://platform.abstract.inc/billing). |
    | 402  | `insufficient_credit`  | Buy credit, or lower `maxTokens` so the reserved cost fits.              |
    | 429  | `spend_limit_exceeded` | The monthly spend limit was reached. Raise it in Platform Billing.       |

    See [Abstract errors and limits](https://abstract.inc/docs/errors) for the full list.

  </Accordion>
</AccordionGroup>

<Note>
For general provider configuration and failover behavior, see [Model Providers](/concepts/model-providers).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Abstract Responses API" href="https://abstract.inc/docs/llm/responses" icon="book">
    Official Abstract documentation for the models, streaming and usage.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs and failover behavior.
  </Card>
  <Card title="Custom providers" href="/gateway/config-tools/custom-providers" icon="gear">
    The `models.providers` field reference.
  </Card>
  <Card title="Models" href="/concepts/models" icon="brain">
    How to choose and configure models.
  </Card>
</CardGroup>
