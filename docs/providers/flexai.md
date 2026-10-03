---
summary: "FlexAI setup (auth + model selection)"
title: "FlexAI"
read_when:
  - You want to use FlexAI with OpenClaw
  - You need the FlexAI API key env var or CLI auth choice
---

[FlexAI](https://flex.ai) serves open-weight models through an OpenAI-compatible API. The plugin discovers the live catalog and its prices, with a bundled catalog for offline fallback.

| Property        | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Provider id     | `flexai`                                                |
| Plugin          | official external package (`@openclaw/flexai-provider`) |
| Auth env var    | `FLEXAI_API_KEY`                                        |
| Onboarding flag | `--auth-choice flexai-api-key`                          |
| Direct CLI flag | `--flexai-api-key <key>`                                |
| API             | OpenAI-compatible (`openai-completions`)                |
| Base URL        | `https://api.flex.ai/v1`                                |
| Default model   | `flexai/Qwen3.6-35B-A3B-FP8`                            |

## Install plugin

```bash
openclaw plugins install @openclaw/flexai-provider
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key from the [FlexAI docs](https://docs.flex.ai).
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice flexai-api-key
```

```bash Direct flag
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice flexai-api-key \
  --flexai-api-key "$FLEXAI_API_KEY"
```

```bash Env only
export FLEXAI_API_KEY=...
```

    </CodeGroup>

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider flexai
    ```

    Lists the configured FlexAI models. If `FLEXAI_API_KEY` is unresolved, `openclaw models status --json` reports the missing credential under `auth.unusableProfiles`.

  </Step>
</Steps>

## Non-interactive setup

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice flexai-api-key \
  --flexai-api-key "$FLEXAI_API_KEY"
```

`--mode` defaults to `local`, so this is the same run as the **Direct flag**
command above. Run it on the Gateway host: remote-client onboarding
(`--mode remote`) only configures the local client connection and does not set
up provider credentials on the server.

## Model ids

Use the id `GET /v1/models` reports, such as `flexai/DeepSeek-V4-Flash-0731`.
FlexAI also resolves a row's declared lowercase alias and its Hugging Face
`org/name` form, but an unrecognized prefix, an unknown name, or the wrong case
returns `404` with a message pointing back at the canonical id. The bundled
catalog and discovery both use the canonical id, so configured model refs keep
working when an alias changes.

## Discovery and pricing

When FlexAI auth is configured, OpenClaw reads `GET /v1/models` through the
configured base URL and projects the chat-capable rows into the catalog. The
same endpoint also lists embedding, transcription, speech, image-generation and
OCR models; those are not selectable as chat models and are filtered out.

Live rows supply the context window, prompt/completion/cached-prompt prices, and
image-input support. FlexAI returns prices as USD per-token strings alongside
per-million fields; OpenClaw reads the per-token form and converts to USD per
million tokens. FlexAI publishes no cache-write tariff, so that rate stays zero;
a zero rate in OpenClaw's estimate is not a claim about FlexAI's billing.

Rows carry an `is_ready` flag that is not a reliable availability signal — it
reads `false` for models that serve requests normally — so discovery does not
filter on it.

Successful catalogs are cached for 60 seconds. If discovery fails, returns an
empty catalog, or has no usable model rows, OpenClaw uses the bundled offline
seed. In the default `models.mode: "merge"`, fresh onboarding does not copy
generated model rows or prices into your config, allowing prices to refresh.
Explicitly authored model rows and costs remain intact. In
`models.mode: "replace"`, discovery is disabled and onboarding keeps the offline
seed as explicit config instead.

### Output limits

FlexAI reports `max_output_length` equal to `context_length` on every row, so it
is not an independent output budget — prompt and completion share the context
window. The catalog therefore publishes the context window as `maxTokens` rather
than inventing a ceiling the API does not impose.

## Built-in catalog

Eleven offline fallback models, with context windows, prices and capability
flags taken from the October 2, 2026 `GET /v1/models` response and from direct
requests against each route on the same date.

| Model ref                                 | Context | Reasoning | Image input | Notes                                               |
| ----------------------------------------- | ------- | --------- | ----------- | --------------------------------------------------- |
| `flexai/Qwen3.6-35B-A3B-FP8`              | 262K    | no        | no          | Default; code-mode preferred                        |
| `flexai/Qwen3-Coder-30B-A3B-Instruct-FP8` | 262K    | no        | no          | Coding model                                        |
| `flexai/DeepSeek-V4-Flash-0731`           | 1M      | yes       | no          | Emits reasoning only when `reasoning_effort` is set |
| `flexai/DeepSeek-V4.1-Flash`              | 1M      | yes       | no          | No `json_schema` structured outputs                 |
| `flexai/GLM-5.3-Flash`                    | 1M      | yes       | yes         | No `json_schema` structured outputs                 |
| `flexai/gpt-oss-120b`                     | 131K    | yes       | no          | Reasoning effort `low`/`medium`/`high` only         |
| `flexai/gpt-oss-20b`                      | 131K    | yes       | no          | Utility default; same effort levels                 |
| `flexai/gemma-4-31b-it`                   | 262K    | no        | yes         | Declines forced tool choice                         |
| `flexai/Qwen3-30B-A3B-Thinking-2507-FP8`  | 262K    | yes       | no          | Thinking model                                      |
| `flexai/MiniMax-M2.7`                     | 200K    | yes       | no          |                                                     |
| `flexai/Llama-3.3-70B-Instruct-FP8`       | 131K    | no        | no          |                                                     |

Every seeded model streams, reports usage in the stream when
`stream_options.include_usage` is set, and emits tool calls.

### Reasoning effort

`reasoning_effort` is validated per route rather than uniformly. The gpt-oss
routes accept `low`, `medium` and `high` and reject anything else;
`DeepSeek-V4-Flash-0731` and `GLM-5.3-Flash` additionally accept `minimal` and
`max` while rejecting unknown spellings. The remaining routes accept any value
without validating it, so the catalog declares a level list only where FlexAI
enforces one. Accepting a level is not evidence that it changes the result:
`DeepSeek-V4-Flash-0731` returns reasoning content only when the parameter is
present, while several routes show no separable effect at any level.

Models that reason return their trace in a non-standard `reasoning_content`
field on the assistant message.

### Forced tool choice

Tool calling works on every seeded model, but forcing a specific function with
`tool_choice: {"type": "function", ...}` is honored per model. `gemma-4-31b-it`
declines, and FlexAI returns `400` naming the model rather than silently
answering without the call.

## Manual config

Most setups only need the API key. Use explicit `models.providers.flexai` config to override model metadata in `mode: "merge"`; leave `models` empty to use discovered rows without pinning generated prices:

```json5
{
  env: { vars: { FLEXAI_API_KEY: "..." } },
  agents: {
    defaults: {
      model: { primary: "flexai/Qwen3.6-35B-A3B-FP8" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      flexai: {
        baseUrl: "https://api.flex.ai/v1",
        apiKey: "${FLEXAI_API_KEY}",
        api: "openai-completions",
        models: [],
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd, systemd, Docker), make sure `FLEXAI_API_KEY` is available to that process — for example in `~/.openclaw/.env` or through `env.shellEnv`. A key exported only in an interactive shell will not help a managed service unless the env is imported separately.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    Reasoning effort levels for the FlexAI models.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles, switching models, and resolving "no profile" errors.
  </Card>
</CardGroup>
