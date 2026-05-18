---
summary: "Use TrustedRouter.com's end-to-end encrypted OpenRouter-compatible LLM router in OpenClaw"
read_when:
  - You want an OpenRouter-compatible router with end-to-end encrypted prompts
  - You want to use TrustedRouter.com as an LLM provider in OpenClaw
title: "TrustedRouter.com"
---

TrustedRouter.com is an OpenRouter-compatible LLM router with end-to-end
encrypted prompt handling. OpenClaw treats it as its own provider so you can keep
OpenRouter and TrustedRouter credentials separate.

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [TrustedRouter.com](https://trustedrouter.com/).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice trustedrouter-api-key
    ```
  </Step>
  <Step title="(Optional) Switch to a specific model">
    Onboarding defaults to `trustedrouter/auto`. Pick a concrete model later:

    ```bash
    openclaw models set trustedrouter/<provider>/<model>
    ```
  </Step>
</Steps>

## Config example

```json5
{
  env: { TRUSTEDROUTER_API_KEY: "sk-tr-v1-..." },
  agents: {
    defaults: {
      model: { primary: "trustedrouter/auto" },
    },
  },
}
```

## Endpoint

OpenClaw uses TrustedRouter's OpenAI-compatible production endpoint:

```text
https://api.quillrouter.com/v1
```

## Related

<CardGroup cols={2}>
  <Card title="OpenRouter" href="/providers/openrouter" icon="route">
    OpenRouter provider setup and OpenRouter-specific request behavior.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
</CardGroup>
