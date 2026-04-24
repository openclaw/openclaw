---
summary: "FuturMix setup (auth + model selection)"
title: "FuturMix"
read_when:
  - You want to use FuturMix with OpenClaw
  - You need the API key env var or CLI auth choice
---

[FuturMix](https://futurmix.ai) is a unified AI gateway providing
OpenAI-compatible access to 22+ models from OpenAI, Anthropic, and Google
through a single API endpoint and key.

| Property | Value                      |
| -------- | -------------------------- |
| Provider | `futurmix`                 |
| Auth     | `FUTURMIX_API_KEY`         |
| API      | OpenAI-compatible          |
| Base URL | `https://futurmix.ai/v1`   |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key at
    [futurmix.ai](https://futurmix.ai).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice futurmix-api-key
    ```
  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "futurmix/claude-sonnet-4-6" },
        },
      },
    }
    ```
  </Step>
</Steps>

### Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice futurmix-api-key \
  --futurmix-api-key "$FUTURMIX_API_KEY"
```

<Note>
The onboarding preset sets `futurmix/claude-sonnet-4-6` as the default
model.
</Note>

## Built-in catalog

OpenClaw ships this bundled FuturMix catalog:

| Model ref                                   | Name                | Input       | Context   | Notes                      |
| ------------------------------------------- | ------------------- | ----------- | --------- | -------------------------- |
| `futurmix/claude-opus-4-7`                  | Claude Opus 4-7     | text, image | 200,000   | Default model; reasoning   |
| `futurmix/claude-opus-4-6`                  | Claude Opus 4-6     | text, image | 200,000   | Reasoning enabled          |
| `futurmix/claude-sonnet-4-6`                | Claude Sonnet 4-6   | text, image | 200,000   | Fast, capable              |
| `futurmix/claude-sonnet-4-5-20250929`       | Claude Sonnet 4.5   | text, image | 200,000   | Balanced performance       |
| `futurmix/claude-haiku-4-5-20251001`        | Claude Haiku 4.5    | text, image | 200,000   | Lightweight, fast          |
| `futurmix/gemini-2.5-pro`                   | Gemini 2.5 Pro      | text, image | 1,048,576 | 1M context                 |
| `futurmix/gemini-2.5-flash`                 | Gemini 2.5 Flash    | text, image | 1,048,576 | Fast, 1M context           |
| `futurmix/gpt-5.4`                          | GPT-5.4             | text, image | 128,000   | Latest OpenAI              |
| `futurmix/gpt-5.4-mini`                     | GPT-5.4 Mini        | text, image | 128,000   | Compact, efficient         |

<AccordionGroup>
  <Accordion title="Environment note">
    If the Gateway runs as a daemon (launchd/systemd), make sure
    `FUTURMIX_API_KEY` is available to that process (for example, in
    `~/.openclaw/.env` or via `env.shellEnv`).

    <Warning>
    Keys set only in your interactive shell are not visible to daemon-managed
    gateway processes. Use `~/.openclaw/.env` or `env.shellEnv` config for
    persistent availability.
    </Warning>

  </Accordion>

  <Accordion title="Troubleshooting">
    - Verify your key works: `openclaw models list --provider futurmix`
    - If models are not appearing, confirm the API key is set in the correct
      environment for your Gateway process.
    - Model refs use the form `futurmix/<model-id>`.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Provider rules, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema including provider settings.
  </Card>
  <Card title="FuturMix" href="https://futurmix.ai" icon="arrow-up-right-from-square">
    FuturMix dashboard, API docs, and pricing.
  </Card>
</CardGroup>
