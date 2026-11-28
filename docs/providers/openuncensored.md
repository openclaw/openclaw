---
summary: "Connect OpenUncensored as a custom OpenAI-compatible provider for uncensored and abliterated open-weight models"
title: "OpenUncensored"
read_when:
  - You want to use uncensored or abliterated open-weight models with OpenClaw
  - You need OpenUncensored model ids, limits, or thinking settings for a custom provider entry
---

[OpenUncensored](https://openuncensored.com) serves uncensored and abliterated
builds of open-weight models, such as DeepSeek, GLM, Kimi, Qwen, and Gemma, behind
one prepaid API key. The API speaks OpenAI Chat Completions, OpenAI Responses, and
Anthropic Messages. Configure it with OpenClaw's existing custom-provider support
and the `openai-completions` API. OpenUncensored's [terms](https://openuncensored.com/terms)
apply to every request.

| Property    | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Provider id | `openuncensored` (custom)                                                             |
| Plugin      | none; not a bundled OpenClaw provider plugin                                          |
| Auth        | Prepaid API key from [openuncensored.com/credits](https://openuncensored.com/credits) |
| API         | `openai-completions`                                                                  |
| Base URL    | `https://api.openuncensored.com/v1`                                                   |

## Quick start

<Steps>
  <Step title="Get a key">
    Buy a prepaid key on the [credits page](https://openuncensored.com/credits). No
    account is needed, and the key is shown once. Export it in the shell you use for
    the next steps:

    ```bash
    export OPENUNCENSORED_API_KEY="example-openuncensored-key-not-real"
    ```

  </Step>
  <Step title="Configure the provider">
    Merge this block into your `openclaw.json`. Keep the `/v1` suffix in `baseUrl`:
    the OpenAI client appends `chat/completions`.

    ```json5
    {
      models: {
        providers: {
          openuncensored: {
            baseUrl: "https://api.openuncensored.com/v1",
            api: "openai-completions",
            models: [
              {
                id: "glm-5.3-flash-uncensored",
                name: "GLM 5.3 Flash Uncensored",
                reasoning: true,
                input: ["text"],
                contextWindow: 1048576,
                maxTokens: 32768,
                compat: {
                  supportsUsageInStreaming: true,
                  supportedReasoningEfforts: ["low", "high", "max"],
                },
              },
              {
                id: "deepseek-v4.1-flash-1017-uncensored",
                name: "DeepSeek V4.1 Flash 1017 Uncensored",
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 1048576,
                maxTokens: 131072,
                compat: {
                  supportsUsageInStreaming: true,
                  supportedReasoningEfforts: ["none", "low", "high", "max"],
                  reasoningEffortMap: { off: "none" },
                },
              },
              {
                id: "kimi-k3.1-pro-uncensored",
                name: "Kimi K3.1 Pro Uncensored",
                reasoning: true,
                input: ["text"],
                contextWindow: 1048576,
                compat: { supportsUsageInStreaming: true },
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openuncensored/glm-5.3-flash-uncensored" },
        },
      },
    }
    ```

  </Step>
  <Step title="Save the key">
    ```bash
    printf '%s\n' "$OPENUNCENSORED_API_KEY" | openclaw models auth paste-api-key --provider openuncensored
    ```

    With the custom provider configured, this stores the key in OpenClaw's shared
    credential store and binds the provider to it. If the command reports that the
    Gateway has not applied the settings, restart the Gateway before testing.

  </Step>
  <Step title="Select and test the model">
    ```bash
    openclaw models set openuncensored/glm-5.3-flash-uncensored
    openclaw agent exec --cwd . --model openuncensored/glm-5.3-flash-uncensored "Reply with the word ready"
    ```

  </Step>
</Steps>

## Models

The example lists three models suited to agent work: GLM 5.3 Flash Uncensored, a
low-cost default; DeepSeek V4.1 Flash 1017 Uncensored, which also accepts images;
and Kimi K3.1 Pro Uncensored, a larger reasoning model. The model list needs no key:

```bash
curl https://api.openuncensored.com/v1/models
```

Add a `models` entry for each id you want to select and reference it as
`openuncensored/<id>`. Set `contextWindow` from the model's `context_length`, and
add `image` to `input` only when the model's `tags` include `vision`. OpenClaw uses
the context window when deciding when to compact a session.

Rates can differ per request, so the example omits `cost` and OpenClaw records these
turns at zero cost. Per-model rates are on the
[models page](https://openuncensored.com/models). To check the credit left on a key:

```bash
curl https://api.openuncensored.com/v1/credits \
  -H "Authorization: Bearer $OPENUNCENSORED_API_KEY"
```

## Tools, usage, and thinking

OpenClaw's agent tools use the standard OpenAI `tools` field, including streamed
tool calls. Models differ in how reliably they finish long multi-step tool loops.
The [OpenUncensored leaderboard](https://openuncensored.com/uncensored-llm-leaderboard)
scores models on multi-step agent tasks; prefer models near the top for long agent
runs.

`compat.supportsUsageInStreaming: true` asks for token usage on streamed responses,
which OpenUncensored returns in the last chunk. Without it, OpenClaw does not request
usage from a custom remote endpoint, so streamed turns record no tokens.

Models marked `reasoning: true` receive the session's thinking level as
`reasoning_effort`. On DeepSeek V4.1 Flash 1017 Uncensored, `none` turns thinking
off, and the `off: "none"` mapping makes `/think off` send it. GLM 5.3 Flash
Uncensored has no `none` level, so `/think off` leaves it reasoning at its default.
Kimi K3.1 Pro Uncensored reasons before it answers; if a turn ends with reasoning and
no visible answer, raise `maxTokens` on its entry. See
[Custom OpenAI-compatible endpoints](/tools/thinking#custom-openai-compatible-endpoints).

## Other APIs

The same key and base URL also serve the OpenAI Responses API (`/v1/responses`) and
the Anthropic Messages API (`/v1/messages`). This page uses Chat Completions.

## Troubleshooting

| Symptom                 | Check                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `401`                   | Save a valid key with the command above.                                                       |
| `402`                   | The key is out of credit. Top it up on the [credits page](https://openuncensored.com/credits). |
| `404`                   | Keep `/v1` at the end of `baseUrl`, and use an exact id from `/v1/models`.                     |
| `429`                   | Wait and retry. A key allows at most 32 requests in flight.                                    |
| Reasoning but no answer | Raise `maxTokens` on the model entry or lower the thinking level.                              |

OpenClaw applies its normal retry, credential cooldown, and model-fallback behavior.
See [Model failover](/concepts/model-failover), including
[Billing disables](/concepts/model-failover#billing-disables) for `402` responses.

See [Model providers](/concepts/model-providers) for custom-provider configuration
and [Models](/concepts/models) for model selection.
