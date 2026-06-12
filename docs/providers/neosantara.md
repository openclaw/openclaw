---
summary: "Neosantara setup (auth + model selection)"
title: "Neosantara"
read_when:
  - You want to use Neosantara with OpenClaw
  - You need the API key env var or CLI auth choice
---

[Neosantara](https://neosantara.xyz) provides access to advanced AI models through a unified, OpenAI-compatible API gateway.

| Property | Value                           |
| -------- | ------------------------------- |
| Provider | `neosantara`                    |
| Auth     | `NEOSANTARA_API_KEY`            |
| API      | OpenAI-compatible               |
| Base URL | `https://api.neosantara.xyz/v1` |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key on the [Neosantara Dashboard](https://dashboard.neosantara.xyz).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice neosantara-api-key
    ```
  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "neosantara/grok-4.1-fast-non-reasoning",
          },
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
  --auth-choice neosantara-api-key \
  --neosantara-api-key "$NEOSANTARA_API_KEY"
```

<Note>
The onboarding preset sets `neosantara/grok-4.1-fast-non-reasoning` as the default model.
</Note>

## Built-in catalog

OpenClaw ships this bundled Neosantara catalog:

| Model ref                                | Name          | Input       | Context | Notes           |
| ---------------------------------------- | ------------- | ----------- | ------- | --------------- |
| `neosantara/grok-4.1-fast-non-reasoning` | Grok 4.1 Fast | text, image | 131,072 | Default model   |
| `neosantara/deepseek-r1`                 | DeepSeek R1   | text        | 65,536  | Reasoning model |

## OpenAI Responses Compatibility

For endpoints that require the OpenAI Responses API rather than standard Chat Completions, an alias provider `neosantara-responses` is registered. This routes requests to Neosantara using the `openai-responses` payload format while reusing the same `NEOSANTARA_API_KEY` credential:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "neosantara-responses/grok-4.1-fast-non-reasoning",
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Environment note">
    If the Gateway runs as a daemon (launchd/systemd), make sure
    `NEOSANTARA_API_KEY` is available to that process (for example, in
    `~/.openclaw/.env` or via `env.shellEnv`).

    <Warning>
    Keys set only in your interactive shell are not visible to daemon-managed
    gateway processes. Use `~/.openclaw/.env` or `env.shellEnv` config for
    persistent availability.
    </Warning>

  </Accordion>

  <Accordion title="Troubleshooting">
    - Verify your key works: `openclaw models list --provider neosantara`
    - If models are not appearing, confirm the API key is set in the correct
      environment for your Gateway process.
    - Model refs use the form `neosantara/<model-id>`.

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
  <Card title="Neosantara Docs" href="https://docs.neosantara.xyz" icon="arrow-up-right-from-square">
    Neosantara API references and billing guides.
  </Card>
</CardGroup>
