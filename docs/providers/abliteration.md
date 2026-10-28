---
summary: "Abliteration setup, model selection, reasoning, and prompt caching"
title: "Abliteration"
read_when:
  - You want to use Abliteration with OpenClaw
  - You need Abliteration model capabilities or thinking-level mappings
---

[Abliteration](https://abliteration.ai) serves abliterated open-weight models
through an OpenAI-compatible API. OpenClaw provides it as an official external
provider plugin with a static model catalog and API-key authentication.
Vendor-side policies apply to every request.

| Property        | Value                                         |
| --------------- | --------------------------------------------- |
| Provider id     | `abliteration`                                |
| Package         | `@openclaw/abliteration-provider`             |
| Auth env vars   | `ABLITERATION_API_KEY` (primary), `ABLIT_KEY` |
| Onboarding flag | `--auth-choice abliteration-api-key`          |
| Direct CLI flag | `--abliteration-api-key <key>`                |
| API             | OpenAI-compatible (`openai-completions`)      |
| Base URL        | `https://api.abliteration.ai/v1`              |
| Default model   | `abliteration/abliterated-model-large-flash`  |

## Setup

Install the plugin:

```bash
openclaw plugins install @openclaw/abliteration-provider
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

Run onboarding:

```bash
openclaw onboard --auth-choice abliteration-api-key
```

For non-interactive setup:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice abliteration-api-key \
  --abliteration-api-key "$ABLITERATION_API_KEY"
```

Or expose the key to the Gateway process:

```bash
export ABLITERATION_API_KEY="example-abliteration-key-not-real"
```

The plugin also accepts `ABLIT_KEY`, the variable used in Abliteration's own
examples. Prefer `ABLITERATION_API_KEY` when configuring OpenClaw.

Verify the provider:

```bash
openclaw models list --provider abliteration
```

## Models

The setup default is **Abliterated Large Flash**: the newest multimodal model,
with a 1,048,576-token context window and the lowest input/output prices in this
catalog. Its onboarding alias is `Abliterated Large Flash`.

Use the model id after the `abliteration/` provider prefix. Context and maximum
output limits are in tokens; maximum output includes reasoning tokens.

| Model id                        | Name                           | Context   | Max output | Input       | Native reasoning modes                                     |
| ------------------------------- | ------------------------------ | --------- | ---------- | ----------- | ---------------------------------------------------------- |
| `abliterated-model-large-flash` | Abliterated Large Flash        | 1,048,576 | 262,144    | Text, image | `none`, `low`, `high`, `max`                               |
| `abliterated-model-large-v2`    | Abliterated Large v2           | 1,000,000 | 999,990    | Text        | `low`, `high`, `max`                                       |
| `abliterated-model`             | Abliterated Model              | 262,144   | 262,134    | Text, image | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `abliterated-model-large`       | Abliterated Large (deprecated) | 1,000,000 | 999,990    | Text        | `none`, `high`, `max`                                      |

Catalog prices are USD per million tokens:

| Model id                        | Input | Output | Cache read | Cache write |
| ------------------------------- | ----- | ------ | ---------- | ----------- |
| `abliterated-model-large-flash` | $1    | $2     | $0.10      | $0          |
| `abliterated-model-large-v2`    | $3    | $5     | $0.30      | $0          |
| `abliterated-model`             | $1    | $3     | $0.10      | $0          |
| `abliterated-model-large`       | $3    | $5     | $0.30      | $0          |

There is no cache-write premium. See Abliteration's [model
catalog](https://docs.abliteration.ai/models.md) and
[pricing](https://docs.abliteration.ai/pricing.md) for current availability and rates.
The plugin does not fetch the vendor catalog during discovery. Operators can add
model ids and metadata through `models.providers.abliteration.models`.

## Thinking levels

OpenClaw sends the model's native mode in the top-level Chat Completions
`reasoning_effort` field. The picker exposes these OpenClaw levels:

| Model                   | OpenClaw level → native effort                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Abliterated Large Flash | `off` → `none`, `low` → `low`, `high` → `high`, `max` → `max`                                                                |
| Abliterated Large v2    | `off` → `low`, `low` → `low`, `high` → `high`, `max` → `max`                                                                 |
| Abliterated Model       | `off` → `none`, `minimal` → `minimal`, `low` → `low`, `medium` → `medium`, `high` → `high`, `xhigh` → `xhigh`, `max` → `max` |
| Abliterated Large       | `off` → `none`, `high` → `high`, `max` → `max`                                                                               |

**Large v2 cannot disable reasoning.** The Off level runs at low reasoning:
OpenClaw sends `reasoning_effort: "low"`, the model's minimum reasoning mode. A requested level absent from its map, such as
`medium`, also resolves to `low`. Prefer the levels offered by the model picker.
Reasoning consumes the output budget before the visible answer, so allow enough
output tokens for both. See [Thinking modes](/tools/thinking) and Abliteration's
[thinking guide](https://docs.abliteration.ai/capabilities/thinking.md).

## Prompt caching

Abliteration applies prompt caching automatically and on a best-effort basis.
OpenClaw sends `prompt_cache_key` as a routing hint on Chat Completions requests;
it does not guarantee a cache hit. The API does not support
`prompt_cache_retention`. See the vendor's [prompt-caching
guide](https://docs.abliteration.ai/capabilities/prompt-caching.md).

Requests are stateless; the plugin does not send `store`. Streaming usage includes
cached input and reasoning-token counts when the service reports them.

## Images and tools

`abliterated-model-large-flash` and `abliterated-model` accept image input: up to
four images across the request history, each up to 12 MB, in PNG, JPEG, WebP, or
GIF format. Large v2 and the deprecated Large model are text-only. See the vendor's
[image limits](https://docs.abliteration.ai/capabilities/images.md).

The API supports tool calling and structured output through `response_format`
(`json_object` or `json_schema`). See the [compatibility
matrix](https://docs.abliteration.ai/compatibility-matrix.md) for endpoint support.

## Troubleshooting

- `401` or `403`: confirm the key is visible to the Gateway process, or run
  onboarding again. `ABLITERATION_API_KEY` takes precedence over `ABLIT_KEY`.
- Missing provider: install `@openclaw/abliteration-provider` and check
  `openclaw plugins list` before selecting a model.
- Unknown model: use an exact catalog id after `abliteration/`, or add an explicit
  model definition under `models.providers.abliteration.models`.
- No visible answer or an output-limit stop: increase the output budget or choose
  a lower supported thinking level. Large v2 still reasons when `off` is selected.
- Image rejected: use a multimodal model and stay within the image count, size,
  and format limits.
- Managed Gateway cannot see the key: put it in `~/.openclaw/.env` or another
  trusted environment source loaded by the service. See [Environment
  variables](/help/environment).

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
- [Thinking modes](/tools/thinking)
