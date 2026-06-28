---
summary: "app.nz setup (OpenAI-compatible gateway with an automatic model router)"
read_when:
  - You want a single API key for many LLMs in OpenClaw
  - You want automatic model routing via app/auto
  - You want to point OpenClaw at the app.nz gateway
title: "app.nz"
---

[app.nz](https://app.nz) is a hosted, OpenAI- and Anthropic-compatible LLM gateway that routes requests across many providers behind a single endpoint and API key. Because it is OpenAI-compatible, OpenClaw uses it as a custom `/v1` backend — no plugin required.

| Property      | Value                                    |
| ------------- | ---------------------------------------- |
| API           | OpenAI-compatible (`openai-completions`) |
| Base URL      | `https://app.nz/v1`                       |
| Auth env var  | `OPENAI_API_KEY` (an `app_live_...` key) |
| Default model | `openai/app/auto`                         |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key (it looks like `app_live_...`) from the [app.nz dashboard](https://app.nz/docs).
  </Step>
  <Step title="Configure OpenClaw">
    Point OpenClaw at app.nz as a custom OpenAI-compatible endpoint:

    ```json5
    {
      env: {
        OPENAI_API_KEY: "app_live_...",
        OPENAI_BASE_URL: "https://app.nz/v1",
      },
      agents: {
        defaults: {
          model: { primary: "openai/app/auto" },
        },
      },
    }
    ```

  </Step>
  <Step title="(Optional) Pick a routing variant or a specific model">
    `app/auto` lets the router pick from the prompt. Bias it with a variant, or
    pin a specific upstream model as `provider/model`:

    ```bash
    openclaw models set openai/app/auto-code
    ```

  </Step>
</Steps>

## Model references

Model refs follow the pattern `openai/<app.nz model>`.

| Model ref                  | Notes                              |
| -------------------------- | ---------------------------------- |
| `openai/app/auto`          | Prompt-aware automatic routing     |
| `openai/app/auto-code`     | Biased toward coding models        |
| `openai/app/auto-reasoning`| Biased toward reasoning models     |
| `openai/app/auto-fast`     | Biased toward low-latency models   |
| `openai/app/auto-cheap`    | Biased toward low-cost models      |
| `openai/app/auto-vision`   | Biased toward vision models        |
| `openai/anthropic/claude`  | Pin a specific upstream `provider/model` |

## Notes

This path uses the same proxy-style OpenAI-compatible route as other custom
`/v1` backends:

- Native OpenAI-only request shaping does not apply (no `service_tier`, no
  Responses `store`, no prompt-cache hints).
- Hidden OpenClaw attribution headers are not injected on the custom URL.

app.nz also exposes an Anthropic-compatible endpoint at `https://app.nz/v1/messages`
using the same key.

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
