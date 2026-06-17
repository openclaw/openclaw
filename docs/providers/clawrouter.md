---
summary: "Use one managed ClawRouter key to access approved providers in OpenClaw"
title: "ClawRouter"
read_when:
  - You have a ClawRouter proxy key
  - Your team centrally manages provider access and grants
  - You want OpenClaw to discover only the models you can use
---

ClawRouter gives OpenClaw one managed credential for approved model providers.
The upstream API keys, OAuth grants, and subscription credentials stay in
ClawRouter.

## Setup

Authenticate with the proxy key issued by your ClawRouter administrator:

```bash
openclaw onboard --auth-choice clawrouter-api-key
```

Or provide it through the environment:

```bash
export CLAWROUTER_API_KEY="clawrouter-live-..."
```

OpenClaw asks `https://clawrouter.openclaw.ai/v1/catalog` for the models granted
to that key and caches the credential-scoped result for a short period. Model
references keep the ClawRouter provider prefix:

```bash
openclaw models list --provider clawrouter
openclaw models set clawrouter/openai/gpt-5.5-mini
```

ClawRouter publishes the real transport for each model. OpenClaw uses the
unified OpenAI route when available and the provider-native Anthropic or Gemini
route when required.

## Custom deployment

For a self-hosted ClawRouter, configure its API base URL:

```json5
{
  models: {
    providers: {
      clawrouter: {
        baseUrl: "https://clawrouter.example/v1",
      },
    },
  },
}
```

The proxy key still determines which providers and models are visible and
usable. Grant changes appear after the short discovery cache expires.
