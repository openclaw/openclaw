---
summary: "Run OpenClaw with LM Studio"
read_when:
  - You want to run OpenClaw with open source models via LM Studio
  - You want to set up and configure LM Studio
title: "LM Studio"
---

LM Studio runs llama.cpp (GGUF) or MLX models locally, as a GUI app or the headless `llmster`
daemon. For install and product docs, see [lmstudio.ai](https://lmstudio.ai/).

## Quick start

<Steps>
  <Step title="Install and start the server">
    Install LM Studio (desktop) or `llmster` (headless), then start the server:

    ```bash
    lms server start --port 1234
    ```

    Or run the headless daemon:

    ```bash
    lms daemon up
    ```

    If using the desktop app, enable JIT for smooth model loading; see the
    [LM Studio JIT and TTL guide](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict).

  </Step>
  <Step title="Set an API key if auth is enabled">
    ```bash
    export LM_API_TOKEN="your-lm-studio-api-token"
    ```

    If LM Studio authentication is disabled, leave the API key blank during setup. See
    [LM Studio Authentication](https://lmstudio.ai/docs/developer/core/authentication).

  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard
    ```

    Choose `LM Studio`, then pick a model at the `Default model` prompt.

    The server URL prompt also accepts host shorthand such as `localhost:1234`.
    Invalid URLs stay in the prompt so you can correct them before model discovery.

    On a fresh guided setup, OpenClaw first queries `/api/v1/models` on the
    default or configured LM Studio host. An existing LLM is offered automatically
    only when LM Studio reports tool training and at least 16K of effective
    context. For loaded models, the loaded instance context takes precedence over
    the larger advertised maximum. The same CLI/macOS setup ladder verifies the
    route with a real completion before saving it. The automatic check never
    downloads a model and ignores embedding-only catalog entries.

  </Step>
</Steps>

Change the default model later:

```bash
openclaw models set lmstudio/qwen/qwen3.5-9b
```

LM Studio model keys use an `author/model-name` format (e.g. `qwen/qwen3.5-9b`); OpenClaw model refs
prepend the provider: `lmstudio/qwen/qwen3.5-9b`. Find the exact key for a model by running the
command below and looking at the `key` field:

```bash
curl http://localhost:1234/api/v1/models
```

After installing another model in LM Studio, refresh OpenClaw's model list:

```bash
openclaw models list --provider lmstudio --refresh
```

In the default merge mode, refresh adds discovered models while preserving your
configured rows and their authored metadata, including names and context limits.
An empty configured `models` array also supports discovery on an unauthenticated
server. `models.mode: "replace"` keeps only explicitly configured models.

## Non-interactive onboarding

```bash
openclaw onboard --non-interactive --accept-risk --skip-health --auth-choice lmstudio
```

Or specify base URL, model, and API key explicitly:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --skip-health \
  --auth-choice lmstudio \
  --custom-base-url http://localhost:1234/v1 \
  --lmstudio-api-key "$LM_API_TOKEN" \
  --custom-model-id qwen/qwen3.5-9b
```

`--custom-model-id` takes the model key as returned by LM Studio (e.g. `qwen/qwen3.5-9b`), without
the `lmstudio/` provider prefix. Pass `--lmstudio-api-key` (or set `LM_API_TOKEN`) for authenticated
servers; omit it for unauthenticated servers and OpenClaw stores a local non-secret marker instead.
`--custom-api-key` is still accepted for compatibility, but `--lmstudio-api-key` is preferred.

This writes `models.providers.lmstudio` and sets the default model to `lmstudio/<custom-model-id>`.
Providing an API key also writes the `lmstudio:default` auth profile.

Add `--json` for a machine-readable result. Connection, HTTP, and model-selection
failures return a JSON error with the same recovery guidance as human output and
exit nonzero without applying the proposed provider configuration.

Interactive setup can additionally prompt for a preferred load context length and applies it across
the discovered models it saves to config.

## Configuration

<a id="thinking-compatibility" />

### Chat transport and thinking

OpenClaw uses LM Studio's [Anthropic-compatible Messages API](https://lmstudio.ai/docs/developer/anthropic-compat/messages)
for chat, including models saved with `api: "openai-completions"`. The shared Messages transport
handles streaming text, thinking, images, tool calls, conversation replay, and token usage.
Your server must provide `/v1/messages`. Embeddings continue to use the existing embeddings endpoint.

Thinking `off` sends `thinking: { type: "disabled" }`. Enabled thinking levels send
`thinking: { type: "enabled" }`; LM Studio controls the reasoning budget, so levels such as
`medium` and `xhigh` do not set distinct budgets. This avoids sending graded
`reasoning_effort` values to binary-thinking models, which can produce an unsupported-setting
warning on Chat Completions. Explicit `thinkingLevelMap` and `reasoningEffortMap` entries still
determine enabled/disabled intent, including in existing saved model configurations.
When no thinking level is requested, LM Studio keeps its own default.

Requests with `responseFormat` (or the `response_format` model parameter, including
`extra_body.response_format`) use
[Chat Completions structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output)
instead: Messages does not enforce a response schema. Routing happens before the request is sent.
This path retains the configured supported reasoning efforts and mappings; the Chat Completions
endpoint may still warn about graded effort on a binary model. Explicit API choices other than
`openai-completions` and `anthropic-messages` retain their selected transport.

<a id="streaming-usage-compatibility" />

Both chat paths remove unsupported `pattern` constraints from tool schemas before sending them.
Chat Completions requests include streaming usage; OpenClaw also recovers token counts from llama.cpp-style
`timings.prompt_n` / `timings.predicted_n` metadata when necessary.

<a id="gemma-4-tool-call-recovery" />

For Gemma 4 models on the Chat Completions path, OpenClaw can recover complete standalone
`<|tool_call>call:...<tool_call|>` batches returned as text. Native tool calls remain authoritative;
truncated, cancelled, or incomplete textual calls are never executed.

### Explicit configuration

```json5
{
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "${LM_API_TOKEN}",
        api: "openai-completions",
        models: [
          {
            id: "qwen/qwen3-coder-next",
            name: "Qwen 3 Coder Next",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Model instances and context

Native discovery and preload support the same credentials as inference, including
store-backed SecretRefs and explicit `Authorization` headers. You do not need to
copy a store-backed API key into an auth profile to enable preload.

With preload enabled, OpenClaw routes chat requests to a loaded instance with
enough context for the selected model budget. A newly loaded instance is addressed by the
identifier returned by LM Studio. Your configured model reference and conversation model identity
keep the configured model key.

Model loads use the configured provider `timeoutSeconds` (or the request timeout override),
with a two-minute default matching embedding loads. Increase `models.providers.lmstudio.timeoutSeconds`
for slow cold loads. If a load fails while every known loaded instance is too small, OpenClaw
reports the model and requested context instead of sending the prompt to a smaller instance.
Wait for loading to finish in LM Studio and retry, or lower the model's `contextTokens`.

With preload enabled, embedding requests also check that their model is loaded and route to the
instance prepared for the configured context length. This avoids truncating input through a smaller
loaded instance and lets memory embeddings recover after model eviction even when LM Studio JIT
loading is disabled. Embedding model and cache identity keep the configured model key.

### Disabling preload

LM Studio supports just-in-time (JIT) model loading, loading models on first request. OpenClaw
preloads models through LM Studio's native load endpoint by default, which helps when JIT is
disabled. To let LM Studio's JIT, idle TTL, and auto-evict behavior own model lifecycle instead,
disable OpenClaw's preload step:

```json5
{
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        params: { preload: false },
        models: [{ id: "qwen/qwen3.5-9b" }],
      },
    },
  },
}
```

### LAN or tailnet host

Use the LM Studio host's reachable address, keep `/v1`, and make sure LM Studio is bound beyond
loopback on that machine:

```json5
{
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://gpu-box.local:1234/v1",
        apiKey: "lmstudio",
        api: "openai-completions",
        models: [{ id: "qwen/qwen3.5-9b" }],
      },
    },
  },
}
```

`lmstudio` automatically trusts its configured endpoint for model requests, including loopback,
LAN, and tailnet hosts (except metadata, link-local, and local-use NAT64
`64:ff9b:1::/48` origins). Any custom/local OpenAI-compatible
provider entry gets the same exact-origin trust. Requests to a different private host or port still
require `models.providers.<id>.request.allowPrivateNetwork: true`; set it to `false` to opt out of
the default trust.

## Troubleshooting

### Context overflow

When LM Studio rejects a prompt because it exceeds the loaded context, OpenClaw attempts
[compaction and retry](/concepts/compaction), including for older servers that report
`Trying to keep the first N tokens` and `the model is loaded with context length of only M tokens, which is not enough`.
If a single message is too large, shorten it or load the model with a larger context; compacting
earlier history cannot shrink that message. Server-side truncation without an overflow error
does not trigger this recovery.

### Model discovery failures

When a configured server cannot list models, OpenClaw reports an unavailable catalog or a
catalog authentication rejection. A refresh can keep the last successful inventory when the
connection and credentials still match. A successful empty response clears discovered models;
explicitly configured models remain available without discovery. Restore the server connection
or correct its credentials, then refresh the model list.

### LM Studio not detected

Make sure LM Studio is running:

```bash
lms server start --port 1234
```

If authentication is enabled, also set `LM_API_TOKEN`. Verify the API is reachable:

```bash
curl http://localhost:1234/api/v1/models
```

### Authentication errors (HTTP 401)

- Check that `LM_API_TOKEN` matches the key configured in LM Studio.
- See [LM Studio Authentication](https://lmstudio.ai/docs/developer/core/authentication).
- If the server does not require authentication, leave the key blank during setup.

## Related

- [Model selection](/concepts/model-providers)
- [Ollama](/providers/ollama)
- [Local models](/gateway/local-models)
