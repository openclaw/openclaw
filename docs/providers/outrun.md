---
summary: "Connect Outrun as a custom OpenAI-compatible provider with one API key"
title: "Outrun"
read_when:
  - You want to use Outrun models with OpenClaw
  - You need a custom provider entry for an OpenAI-compatible endpoint with one key
---

[Outrun](https://outrun.to) is a prepaid, OpenAI-compatible API with one key for GPT, Claude, Gemini,
Grok, DeepSeek, GLM, Kimi, Qwen and MiniMax models. Configure it with OpenClaw's existing
custom-provider support and the `openai-completions` API.

| Property    | Value                                                  |
| ----------- | ------------------------------------------------------ |
| Provider id | `outrun` (custom; configure under `models.providers.outrun`) |
| Plugin      | none; not a bundled OpenClaw provider plugin           |
| Auth        | Outrun API key from [outrun.to/key](https://outrun.to/key), sent as a bearer token |
| API         | `openai-completions`                                   |
| Base URL    | `https://api.outrun.to/v1`                             |

<Note>
  Outrun is a custom OpenAI-compatible provider, not a bundled OpenClaw provider plugin.
  `openclaw onboard` offers no Outrun auth choice, so you write the `models.providers.outrun`
  entry yourself.
</Note>

## Quick start

<Steps>
  <Step title="Create a key">
    Create an API key at [outrun.to/key](https://outrun.to/key) and export it in the shell
    you use for the next steps:

    ```bash
    export OUTRUN_API_KEY="example-outrun-key-not-real"
    ```

  </Step>
  <Step title="Add the provider to your config">
    Merge this block into your `openclaw.json`. Keep the `/v1` suffix in `baseUrl`: the OpenAI
    client appends `chat/completions`.

    ```json5
    {
      models: {
        providers: {
          outrun: {
            baseUrl: "https://api.outrun.to/v1",
            apiKey: "${OUTRUN_API_KEY}",
            api: "openai-completions",
            models: [
              {
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                input: ["text", "image"],
                contextWindow: 1050000,
                maxTokens: 128000,
              },
              {
                id: "claude-sonnet-5-5",
                name: "Claude Sonnet 5.5",
                input: ["text", "image"],
                contextWindow: 1000000,
                maxTokens: 128000,
              },
              {
                id: "gemini-3.8-flash",
                name: "Gemini 3.8 Flash",
                input: ["text", "image"],
                contextWindow: 1048576,
                maxTokens: 65536,
              },
              {
                id: "deepseek-v4-pro",
                name: "DeepSeek V4 Pro",
                input: ["text"],
                contextWindow: 1000000,
                maxTokens: 393216,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "outrun/claude-sonnet-5-5" },
        },
      },
    }
    ```

    `${OUTRUN_API_KEY}` resolves from the Gateway process environment or `~/.openclaw/.env`. See
    [Environment](/help/environment).

  </Step>
  <Step title="Select a model">
    ```bash
    openclaw models set outrun/claude-sonnet-5-5
    openclaw models list --provider outrun
    ```
  </Step>
</Steps>

## Models

Outrun uses plain model IDs with no vendor prefix, such as `gpt-5.6-sol`, `claude-sonnet-5-5`,
`gemini-3.8-flash` and `deepseek-v4-pro`. Add a `models` entry for each ID you want to select. The
[model list](https://outrun.to/pricing) shows every ID, and the
[API reference](https://outrun.to/docs/api) covers the endpoints. Listing models through the API
needs your key:

```bash
curl https://api.outrun.to/v1/models \
  -H "Authorization: Bearer $OUTRUN_API_KEY"
```

`cost` is left out of the example, so OpenClaw reports zero cost. Fill it in from the
[model list](https://outrun.to/pricing) if you want cost tracking. OpenClaw reads `cost` in USD per
million tokens.

| Symptom | Check                                                       |
| ------- | ----------------------------------------------------------- |
| `401`   | Check that `OUTRUN_API_KEY` is set where the Gateway can read it. |
| `404`   | Keep `/v1` at the end of `baseUrl`.                         |

See [Model providers](/concepts/model-providers) for custom-provider configuration and
[Models](/concepts/models) for model selection.
