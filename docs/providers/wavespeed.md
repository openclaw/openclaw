---
title: "WaveSpeed"
summary: "WaveSpeed setup (auth + model selection)"
read_when:
  - You want to use WaveSpeed with OpenClaw
  - You need the API key env var or CLI auth choice
---

# WaveSpeed

[WaveSpeed](https://wavespeed.ai) provides OpenAI-compatible access to hosted LLMs through a unified endpoint. OpenClaw treats WaveSpeed as a first-class named provider, so onboarding, default model selection, and provider docs all work without hand-writing a custom endpoint block.

| Property | Value |
| -------- | ----- |
| Provider | `wavespeed` |
| Auth | `WAVESPEED_API_KEY` |
| API | OpenAI-compatible |
| Base URL | `https://llm.wavespeed.ai/v1` |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key from the [WaveSpeed dashboard](https://wavespeed.ai).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice wavespeed-api-key
    ```
  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "wavespeed/google/gemini-2.5-flash" },
        },
      },
    }
    ```
  </Step>
</Steps>

## Non-interactive setup

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice wavespeed-api-key \
  --wavespeed-api-key "$WAVESPEED_API_KEY"
```

## Built-in catalog

OpenClaw currently ships this bundled WaveSpeed starter catalog:

| Model ref | Name | Input | Context | Notes |
| --------- | ---- | ----- | ------- | ----- |
| `wavespeed/google/gemini-2.5-flash` | Gemini 2.5 Flash | text, image | 1M | Default model; fast general-purpose multimodal option |
| `wavespeed/anthropic/claude-sonnet-4.6` | Claude Sonnet 4.6 | text, image | 200K | Strong coding and reasoning |
| `wavespeed/anthropic/claude-opus-4.6` | Claude Opus 4.6 | text, image | 200K | Highest-capability Anthropic option |
| `wavespeed/openai/gpt-4.1` | GPT-4.1 | text, image | 1M | Broad OpenAI-compatible baseline |

<Tip>
The onboarding preset sets `wavespeed/google/gemini-2.5-flash` as the default model.
</Tip>

## Supported features

| Feature | Supported |
| ------- | --------- |
| Streaming | Yes |
| Tool use / function calling | Yes |
| Structured output | Yes |
| Vision input | Yes |

<AccordionGroup>
  <Accordion title="Environment note">
    If the Gateway runs as a daemon, make sure `WAVESPEED_API_KEY` is available
    to that process (for example, in `~/.openclaw/.env` or via `env.shellEnv`).
  </Accordion>

  <Accordion title="Pricing note">
    WaveSpeed routes to upstream hosted models. OpenClaw's bundled catalog is
    focused on stable defaults and does not try to mirror WaveSpeed's full live
    catalog or pricing surface yet.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Provider directory" href="/providers" icon="book-open">
    Browse all built-in OpenClaw provider integrations.
  </Card>
</CardGroup>
