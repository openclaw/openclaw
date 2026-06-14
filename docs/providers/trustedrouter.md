---
summary: "Use TrustedRouter's attested OpenAI-compatible API from OpenClaw"
read_when:
  - You want to run OpenClaw through TrustedRouter
  - You want attested routing, zero-data-retention routes, or end-to-end encrypted routes
  - You want an OpenAI-compatible custom provider setup
title: "TrustedRouter"
---

TrustedRouter provides an OpenAI-compatible API at `https://api.trustedrouter.com/v1`.
Use it in OpenClaw as a custom text-inference provider.

## Getting started

<Steps>
  <Step title="Create a TrustedRouter API key">
    Sign in to [TrustedRouter](https://trustedrouter.com/console/keys), create an API key,
    and copy it.
  </Step>
  <Step title="Add the provider to your config">
    ```json5
    {
      env: { TRUSTEDROUTER_API_KEY: "sk-tr-..." },
      models: {
        mode: "merge",
        providers: {
          trustedrouter: {
            baseUrl: "https://api.trustedrouter.com/v1",
            apiKey: "TRUSTEDROUTER_API_KEY",
            api: "openai-completions",
            models: [
              {
                id: "trustedrouter/auto",
                name: "TrustedRouter Auto",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
              {
                id: "trustedrouter/zdr",
                name: "TrustedRouter ZDR",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
              {
                id: "trustedrouter/e2e",
                name: "TrustedRouter E2E",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "trustedrouter/trustedrouter/auto" },
        },
      },
    }
    ```
  </Step>
  <Step title="Select a TrustedRouter route">
    ```bash
    openclaw models set trustedrouter/trustedrouter/auto
    ```
  </Step>
</Steps>

## Model references

When using a custom provider, OpenClaw model refs follow the pattern
`provider/model`. TrustedRouter model IDs also contain `/`, so the complete
OpenClaw model ref includes the provider prefix:

| Model ref                         | Notes                                 |
| --------------------------------- | ------------------------------------- |
| `trustedrouter/trustedrouter/auto` | Healthy-provider routing and fallback |
| `trustedrouter/trustedrouter/zdr`  | Zero-data-retention route preference  |
| `trustedrouter/trustedrouter/e2e`  | End-to-end encrypted route preference |

## Attestation

TrustedRouter publishes hosted gateway trust material at
[trust.trustedrouter.com](https://trust.trustedrouter.com/). Use that page to
verify the attested gateway and source links for the hosted API.

## Notes

- This setup uses OpenClaw's OpenAI-compatible chat completions adapter.
- If you want to expose a direct TrustedRouter model, add it under
  `models.providers.trustedrouter.models` and select
  `trustedrouter/<model-id>`.
- For secret storage, prefer OpenClaw SecretRef or environment-backed secrets
  instead of committing raw API keys into config.
