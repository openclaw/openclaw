---
summary: "Use Safe AI Labs' OpenAI-compatible API, served per region, as a custom OpenClaw provider"
title: "Safe AI Labs"
read_when:
  - You have a Safe AI Labs API key and want OpenClaw to use it
  - You need the context window, output limit and timeout for a Safe AI Labs model
---

[Safe AI Labs](https://safeailabs.ai) serves an OpenAI-compatible Chat Completions API with one
endpoint per region. OpenClaw talks to it over the `openai-completions` transport.

| Property    | Value                                                                |
| ----------- | -------------------------------------------------------------------- |
| Provider id | `safeailabs` (custom; configure under `models.providers.safeailabs`) |
| Plugin      | none; not a bundled OpenClaw provider plugin                         |
| Auth        | Safe AI Labs API key, sent as a bearer token                         |
| API         | `openai-completions`                                                 |
| Base URL    | `https://us.api.safeailabs.ai/v1` (US region)                        |

<Note>
  Safe AI Labs is a custom OpenAI-compatible provider, not a bundled OpenClaw provider plugin.
  `openclaw onboard` offers no Safe AI Labs auth choice, so you write the
  `models.providers.safeailabs` entry yourself.
</Note>

## Quick start

<Steps>
  <Step title="Create an API key">
    Create a key at [safeailabs.ai/keys](https://safeailabs.ai/keys) and put it in the environment
    OpenClaw runs in, or in `~/.openclaw/.env`:

    ```bash
    export SAFE_AI_KEY="sail_example-not-real"
    ```

  </Step>
  <Step title="Add the provider to your config">
    Copy the [Configuration](#configuration) block below into `~/.openclaw/openclaw.json`. To use a
    region other than the US, replace the host with that region's, listed on the
    [regions page](https://safeailabs.ai/docs/regions).
  </Step>
  <Step title="Select the model">
    ```bash
    openclaw models set safeailabs/sail-frontier
    openclaw models list --provider safeailabs
    ```
  </Step>
</Steps>

## Configuration

```json5
{
  models: {
    providers: {
      safeailabs: {
        baseUrl: "https://us.api.safeailabs.ai/v1",
        apiKey: "${SAFE_AI_KEY}",
        api: "openai-completions",
        timeoutSeconds: 3600,
        models: [
          {
            id: "sail-frontier",
            name: "Sail Frontier",
            contextWindow: 1048576,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "safeailabs/sail-frontier" },
    },
  },
}
```

### Context window and output limit

Keep `contextWindow` and `maxTokens`. Without them OpenClaw budgets 200,000 tokens of context and
8,192 output tokens for a model it does not know, not the model's own limits. The values above are
the ones `GET /v1/models` reports for `sail-frontier`: 1,048,576 tokens of context and
65,536 output tokens.

### Timeout

Keep `timeoutSeconds`. For a cloud endpoint OpenClaw waits 120 seconds for the first response event,
and the API's keep-alive comments do not count as one. On a Safe AI Labs API plan, a long prompt
waits for the plan's token rate before its first token: about 44 minutes for a 200,000-token prompt
on the smallest plan. `timeoutSeconds: 3600` covers that. See
[Custom providers](/concepts/model-providers/custom-providers) for what the provider timeout covers.

## Models

Model ids are Safe AI Labs' own, such as `sail-frontier`, so a model ref is
`safeailabs/<model>`. To list what a region serves, with each model's context window
and output limit:

```bash
curl https://us.api.safeailabs.ai/v1/models
```

Add a `models` entry for each model you use, with `contextWindow` and `maxTokens` taken from that
response (`max_context_length` and `max_length`).

<Note>
For general provider configuration and failover behavior, see [Model Providers](/concepts/model-providers).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Safe AI Labs docs" href="https://safeailabs.ai/docs" icon="book">
    API reference, regions and models.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs and failover behavior.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
  <Card title="Custom providers" href="/concepts/model-providers/custom-providers" icon="plug">
    Every field a custom provider entry accepts.
  </Card>
</CardGroup>
