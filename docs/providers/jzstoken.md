---
summary: "Use JZSTOKEN's OpenAI-compatible API with OpenClaw"
read_when:
  - You want one API key for models from several model families
  - You want to run JZSTOKEN models in OpenClaw
title: "JZSTOKEN"
---

[JZSTOKEN](https://jzstoken.com) provides OpenAI-compatible Chat Completions
access to models from OpenAI, Anthropic, Google, Kimi, DeepSeek, and other
families through one API key.

| Property    | Value                                                     |
| ----------- | --------------------------------------------------------- |
| Provider id | `jzstoken` (custom; configure under `models.providers`)   |
| Plugin      | none; configure it as a custom OpenAI-compatible provider |
| Auth        | `JZSTOKEN_API_KEY`                                        |
| API         | `openai-completions`                                      |
| Base URL    | `https://jzstoken.com/api/v1`                             |

<Note>
  JZSTOKEN is not a bundled OpenClaw provider plugin. `openclaw onboard` does
  not offer a JZSTOKEN auth choice, so add the provider configuration below.
</Note>

## Setup

<Steps>
  <Step title="Create an API key">
    Create a Standard key at
    [jzstoken.com/dashboard/keys](https://jzstoken.com/dashboard/keys).
  </Step>
  <Step title="Add the API key">
    Add the key to `~/.openclaw/.env`:

    ```bash
    JZSTOKEN_API_KEY=sk-your-key-here
    ```

  </Step>
  <Step title="Add the provider configuration">
    Add the provider and select its default model in `~/.openclaw/openclaw.json`:

    ```json5
    {
      models: {
        providers: {
          jzstoken: {
            baseUrl: "https://jzstoken.com/api/v1",
            apiKey: "${JZSTOKEN_API_KEY}",
            api: "openai-completions",
            models: [
              {
                id: "claude-sonnet-5",
                name: "Claude Sonnet 5",
                input: ["text", "image"],
                contextWindow: 1000000,
              },
              {
                id: "gpt-5.6-terra",
                name: "GPT-5.6 Terra",
                input: ["text", "image"],
                contextWindow: 258000,
              },
              {
                id: "deepseek-v4-pro",
                name: "DeepSeek V4 Pro",
                input: ["text"],
                contextWindow: 1000000,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "jzstoken/claude-sonnet-5" },
        },
      },
    }
    ```

  </Step>
  <Step title="Verify the model">
    ```bash
    openclaw models list --provider jzstoken
    openclaw models set jzstoken/claude-sonnet-5
    ```
  </Step>
</Steps>

## Models

OpenClaw uses `jzstoken/<model-id>`, where `<model-id>` is the exact ID from the
[JZSTOKEN model catalog](https://jzstoken.com/model-pricing). To inspect the
models available to your key:

The Gateway reads `JZSTOKEN_API_KEY` from `~/.openclaw/.env`, but that file is
not automatically loaded into your current shell. Prompt for the key without
echoing it or adding it to shell history, then call the catalog endpoint:

```bash
read -rsp "JZSTOKEN_API_KEY: " JZSTOKEN_API_KEY
export JZSTOKEN_API_KEY
printf '\n'
```

```bash
curl https://jzstoken.com/api/v1/models \
  -H "Authorization: Bearer $JZSTOKEN_API_KEY"
```

Add the returned IDs under `models.providers.jzstoken.models`. A key created
for `jzs-max-3.0` only exposes that model; use a Standard key for other models.

## Behavior notes

<AccordionGroup>
  <Accordion title="Custom OpenAI-compatible transport">
    OpenClaw sends requests to the provider's
    `/chat/completions` route with a Bearer token. Proxy-style
    `openai-completions` behavior applies, including the default omission of
    native OpenAI-only request fields.
  </Accordion>
  <Accordion title="Context and output limits">
    Set `contextWindow` per model when JZSTOKEN publishes a value. Leave
    `maxTokens` unset when the provider does not publish a per-model output
    limit; OpenClaw then lets the endpoint use its default.
  </Accordion>
  <Accordion title="Reasoning controls">
    Custom `openai-completions` models send `reasoning_effort` when marked
    `reasoning: true`. JZSTOKEN does not currently certify that field for every
    model, so the example omits it. Enable reasoning per model only after
    verifying the endpoint accepts the field.
  </Accordion>
  <Accordion title="Troubleshooting">
    - If the provider is not recognized, confirm that
      `models.providers.jzstoken` is present in the active configuration.
    - If authentication fails, confirm that the Gateway process can read
      `JZSTOKEN_API_KEY`.
    - If a model is unavailable, compare its ID with the response from
      `/api/v1/models` for the key in use.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Custom providers" href="/concepts/model-providers/custom-providers" icon="sliders">
    Configure custom OpenAI-compatible endpoints.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Provider rules, model refs, and failover behavior.
  </Card>
  <Card title="JZSTOKEN" href="https://jzstoken.com" icon="arrow-up-right-from-square">
    API keys, account details, and current model catalog.
  </Card>
</CardGroup>
