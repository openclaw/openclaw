---
summary: "Use Requesty's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via Requesty in OpenClaw
title: "Requesty"
---

[Requesty](https://requesty.ai) provides a **unified API** that routes requests to many models
behind a single endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by
switching the base URL to `https://router.requesty.ai/v1`.

See the [Requesty docs](https://docs.requesty.ai) for the full provider and model catalog.

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [app.requesty.ai/api-keys](https://app.requesty.ai/api-keys).
  </Step>
  <Step title="Run API-key onboarding">
    ```bash
    openclaw onboard --auth-choice requesty-api-key
    ```
  </Step>
  <Step title="(Optional) Switch to a specific model">
    Onboarding defaults to `requesty/openai/gpt-4o`. Pick a concrete model later:

    ```bash
    openclaw models set requesty/<provider>/<model>
    ```

  </Step>
</Steps>

## Config example

```json5
{
  env: { REQUESTY_API_KEY: "rqsty-sk-..." },
  agents: {
    defaults: {
      model: { primary: "requesty/openai/gpt-4o" },
    },
  },
}
```

## Model references

<Note>
Model refs follow the pattern `requesty/<provider>/<model>`. Browse the available models at
[app.requesty.ai/router/list](https://app.requesty.ai/router/list) or fetch them from the
OpenAI-compatible `https://router.requesty.ai/v1/models` endpoint.
</Note>

Bundled fallback examples:

| Model ref                              | Notes                          |
| -------------------------------------- | ------------------------------ |
| `requesty/openai/gpt-4o`               | OpenAI GPT-4o via Requesty     |
| `requesty/anthropic/claude-sonnet-4-5` | Claude Sonnet 4.5 via Requesty |
| `requesty/google/gemini-2.5-flash`     | Gemini 2.5 Flash via Requesty  |

Any other `requesty/<provider>/<model>` ref the router accepts also resolves dynamically.
OpenClaw reads per-model capabilities (reasoning, vision, tool calling, context window) from
Requesty's `/v1/models` payload when an API key is configured, so reasoning-capable models keep
their reasoning support.

## Authentication and headers

Requesty uses a Bearer token with your API key. OpenClaw stores it in the `requesty:default`
API-key auth profile. For an existing install, rotate the stored key without rerunning full
onboarding:

```bash
openclaw models auth login --provider requesty --method api-key
```

## Base URL

The OpenAI-compatible base URL is `https://router.requesty.ai/v1`. OpenClaw canonicalizes the
bare host (`https://router.requesty.ai`) onto this `/v1` base.

<Warning>
If you repoint the Requesty provider at some other proxy or base URL, OpenClaw does **not** apply
the Requesty-specific transport normalization.
</Warning>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
