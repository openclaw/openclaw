---
summary: "Use Preferred Networks PLaMo models in OpenClaw"
read_when:
  - You want to use PLaMo models with OpenClaw
  - You need Preferred Networks API key onboarding and model refs
title: "Preferred Networks"
---

# Preferred Networks

Preferred Networks provides the PLaMo model family through the PreferredAI
platform API. OpenClaw shows **Preferred Networks** as the provider name in
onboarding and auth surfaces, while model refs keep the `plamo/...` prefix.

- Provider: `plamo`
- Auth: `PLAMO_API_KEY`
- API: OpenAI-compatible Chat Completions (`https://api.platform.preferredai.jp/v1`)
- Default model: `plamo/plamo-3.0-prime-beta` (`PLaMo 3.0 Prime Beta`)

## Getting started

<Steps>
  <Step title="Get your API key">
    Create or copy an API key from the PreferredAI platform.
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice plamo-api-key
    ```

    Or pass the key directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice plamo-api-key \
      --plamo-api-key "$PLAMO_API_KEY"
    ```

  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "plamo/plamo-3.0-prime-beta" },
        },
      },
    }
    ```
  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider plamo
    ```
  </Step>
</Steps>

## Naming

- **Preferred Networks** is the provider/company name shown in onboarding,
  `models auth`, and plugin metadata.
- **PLaMo** is the model family name. Keep using `plamo/...` model refs, such
  as `plamo/plamo-3.0-prime-beta`.

## Built-in catalog

| Model ref                    | Input | Context | Max output | Notes         |
| ---------------------------- | ----- | ------- | ---------- | ------------- |
| `plamo/plamo-3.0-prime-beta` | text  | 65,536  | 20,000     | Default model |

## Advanced configuration

OpenClaw writes the provider under `models.providers.plamo`:

```json5
{
  models: {
    providers: {
      plamo: {
        baseUrl: "https://api.platform.preferredai.jp/v1",
        api: "openai-completions",
        models: [{ id: "plamo-3.0-prime-beta", name: "PLaMo 3.0 Prime Beta" }],
      },
    },
  },
}
```

The provider also supports request-authenticated proxy setups through
`models.providers.plamo.request` or auth headers, matching the shared
OpenAI-compatible provider configuration surface.

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Models CLI" href="/cli/models" icon="terminal">
    List, set, and inspect configured models.
  </Card>
</CardGroup>
