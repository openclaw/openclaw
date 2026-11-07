---
summary: "Connect Wally as a custom OpenAI-compatible provider for hosted open-weight models"
title: "Wally"
read_when:
  - You want to use Wally (RunAnywhere) open-weight models with OpenClaw
  - You need Wally model limits, prices, or thinking settings for a custom provider entry
---

[Wally](https://www.runwally.com) by RunAnywhere serves open-weight models such as
DeepSeek, GLM, Kimi, and MiniMax through an OpenAI-compatible endpoint. Configure
it with OpenClaw's existing custom-provider support and the `openai-completions` API.

| Property    | Value                                                                       |
| ----------- | --------------------------------------------------------------------------- |
| Provider id | `wally` (custom)                                                            |
| Plugin      | none; not a bundled OpenClaw provider plugin                                |
| Auth        | Wally API key from [console.runanywhere.ai](https://console.runanywhere.ai) |
| API         | `openai-completions`                                                        |
| Base URL    | `https://inference.runanywhere.ai/v1`                                       |

## Quick start

<Steps>
  <Step title="Create a key">
    Sign in at [console.runanywhere.ai](https://console.runanywhere.ai) and create an
    API key. Export it in the shell you use for the next steps:

    ```bash
    export WALLY_API_KEY="example-wally-key-not-real"
    ```

  </Step>
  <Step title="Configure the provider">
    Merge this block into your `openclaw.json`. Keep the `/v1` suffix in `baseUrl`:
    the OpenAI client appends `chat/completions`.

    ```json5
    {
      models: {
        providers: {
          wally: {
            baseUrl: "https://inference.runanywhere.ai/v1",
            api: "openai-completions",
            models: [
              {
                id: "deepseek-v4.1-flash",
                name: "DeepSeek V4.1 Flash",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0.275, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
                contextWindow: 1048576,
                maxTokens: 65536,
                compat: {
                  supportsUsageInStreaming: true,
                  supportedReasoningEfforts: ["none", "low", "medium", "high", "max"],
                  reasoningEffortMap: { off: "none" },
                },
              },
            ],
          },
        },
      },
    }
    ```

  </Step>
  <Step title="Save the key">
    ```bash
    printf '%s\n' "$WALLY_API_KEY" | openclaw models auth paste-api-key --provider wally
    ```

    With the custom provider configured, this stores the key in OpenClaw's shared
    credential store and binds the provider to it. If the command reports that the
    Gateway has not applied the settings, restart the Gateway before testing.

  </Step>
  <Step title="Select and test the model">
    ```bash
    openclaw models set wally/deepseek-v4.1-flash
    openclaw agent exec --cwd . --model wally/deepseek-v4.1-flash "Reply with the word ready"
    ```

  </Step>
</Steps>

## Models

The public catalog lists every model with its limits, input types, prices, and
thinking levels. It needs no key:

```bash
curl https://inference.runanywhere.ai/v1/models
```

Add a `models` entry for each id you want to select, filled from that model's
catalog entry:

| Catalog field                                                      | Model entry field                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `context_length`                                                   | `contextWindow`                                                        |
| `max_output_tokens`                                                | `maxTokens`                                                            |
| `input_modalities`                                                 | `input`; add `image` only when the catalog lists it                    |
| `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read` | `cost.input`, `cost.output`, `cost.cacheRead`, multiplied by 1,000,000 |
| `reasoning.levels`, `reasoning.thinking_off`                       | `compat.supportedReasoningEfforts`, `compat.reasoningEffortMap`        |

Catalog prices are USD per token; OpenClaw reads `cost` in USD per million tokens.
See [Wally pricing](https://www.runwally.com/pricing) for the same rates.

## Usage and thinking

`compat.supportsUsageInStreaming: true` asks Wally for token usage on streamed
responses. Without it, OpenClaw does not request usage from a custom remote endpoint,
so streamed turns record no tokens or cost.

Wally models that reason accept `reasoning_effort`, and OpenClaw sends the session's
thinking level there. On DeepSeek V4.1 Flash, `none` turns thinking off; the
`off: "none"` mapping makes `/think off` send it. Without the mapping, OpenClaw omits
the field for `/think off` and the model keeps thinking at its server default. A model
whose catalog entry has `thinking_off: false`, such as GLM-5.3 Flash, always thinks:
leave `none` and the `off` mapping out of its entry, and expect `/think off` to have no
effect on it. See
[Custom OpenAI-compatible endpoints](/tools/thinking#custom-openai-compatible-endpoints).

| Symptom | Check                                    |
| ------- | ---------------------------------------- |
| `401`   | Save a valid key with the command above. |
| `404`   | Keep `/v1` at the end of `baseUrl`.      |

## Wally CLI

The [Wally CLI](https://docs.runanywhere.ai/integrations) can also start OpenClaw on a
Wally model. It merges its provider entry into your `openclaw.json` and starts the
local TUI:

```bash
wally openclaw -m deepseek-v4.1-flash
```

See [Model providers](/concepts/model-providers) for custom-provider configuration
and [Models](/concepts/models) for model selection.
