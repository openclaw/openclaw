---
title: "Abliteration"
summary: "Abliteration setup (auth + model selection)"
read_when:
  - You want to use abliteration.ai with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Abliteration

[abliteration.ai](https://abliteration.ai) exposes Anthropic-compatible and
OpenAI-compatible endpoints. The bundled OpenClaw provider uses the
Anthropic-compatible Messages route so it appears directly in the onboarding
provider picker.

| Property | Value                                       |
| -------- | ------------------------------------------- |
| Provider | `abliteration`                              |
| Auth     | `ABLITERATION_API_KEY`                      |
| API      | Anthropic-compatible (`anthropic-messages`) |
| Base URL | `https://api.abliteration.ai`               |

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key in your
    [abliteration.ai dashboard](https://abliteration.ai).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice abliteration-api-key
    ```

    This will prompt for your API key and set
    `abliteration/abliterated-model` as the default model.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider abliteration
    ```
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice abliteration-api-key \
      --abliteration-api-key "$ABLITERATION_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Note>
For Anthropic-compatible providers, OpenClaw stores the API origin without
`/v1`. The runtime appends `/v1/messages` and `/v1/messages/count_tokens`
internally.
</Note>

## Built-in catalog

| Model ref                        | Name              | Input      | Context | Max output | Notes                          |
| -------------------------------- | ----------------- | ---------- | ------- | ---------- | ------------------------------ |
| `abliteration/abliterated-model` | Abliterated Model | text,image | 128,000 | 8,192      | Default model; Anthropic route |

## Config example

```json5
{
  env: { ABLITERATION_API_KEY: "ak_..." },
  agents: {
    defaults: {
      model: { primary: "abliteration/abliterated-model" },
    },
  },
}
```

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
