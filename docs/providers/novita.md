---
summary: "Use NovitaAI's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw with NovitaAI models
  - You need the Novita provider id, key, or endpoint
title: "NovitaAI"
---

NovitaAI is a hosted AI infrastructure provider with an OpenAI-compatible API.
OpenClaw provides NovitaAI through the official external
`@openclaw/novita-provider` plugin. Model refs use the
`novita/deepseek/deepseek-v4-pro` form.

## Setup

Install the plugin:

```bash
openclaw plugins install @openclaw/novita-provider
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

Create an API key at [novita.ai/settings/key-management](https://novita.ai/settings/key-management), then run:

```bash
openclaw onboard --auth-choice novita-api-key
```

Or set:

```bash
export NOVITA_API_KEY="<your-novita-api-key>" # pragma: allowlist secret
```

## Defaults

| Setting       | Value                             |
| ------------- | --------------------------------- |
| Plugin        | `@openclaw/novita-provider`       |
| Provider id   | `novita`                          |
| Aliases       | `novita-ai`, `novitaai`           |
| Base URL      | `https://api.novita.ai/openai/v1` |
| Env var       | `NOVITA_API_KEY`                  |
| Default model | `novita/deepseek/deepseek-v4-pro` |

## Model catalog

- `novita/moonshotai/kimi-k3`
- `novita/moonshotai/kimi-k2.7-code`
- `novita/minimax/minimax-m3`
- `novita/zai-org/glm-5.2`
- `novita/deepseek/deepseek-v4-pro`
- `novita/deepseek/deepseek-v4-flash`
- `novita/qwen/qwen3.7-max`

`novita/minimax/minimax-m2.7` remains selectable as a deprecated compatibility
entry but is hidden from model pickers.

This is a starting point, not a live catalog. Your account, region, or
Novita's current offering may add, remove, or restrict routes. Check before
setting a long-lived default:

```bash
openclaw models list --provider novita
```

## Video generation

The same plugin and `NOVITA_API_KEY` support the [video generation tool](/tools/video-generation)
through Novita's native asynchronous API at `https://api.novita.ai`.

| Model                         | Modes                      | Duration | Resolution  |
| ----------------------------- | -------------------------- | -------- | ----------- |
| `wan2.6-t2v` (default)        | Text or one image to video | 5/10/15s | 720P, 1080P |
| `wan2.6-i2v`                  | One image to video         | 5/10/15s | 720P, 1080P |
| `minimax-hailuo-2.3-t2v`      | Text or one image to video | 6/10s    | 768P, 1080P |
| `minimax-hailuo-2.3-i2v`      | One image to video         | 6/10s    | 768P, 1080P |
| `minimax-hailuo-2.3-fast-i2v` | One image to video         | 6/10s    | 768P, 1080P |

Supplying one image with a `-t2v` model selects the same family's `-i2v` route.
Both families accept remote image URLs and local image files, sent as data URIs.
Hailuo supports 1080P only for 6-second videos; use 768P for 10 seconds. Video
reference inputs are unsupported.

Wan defaults to silent output; set `audio: true` to generate audio. It also accepts
one remote HTTP(S) audio reference. Text-to-video supports `16:9`, `9:16`, `1:1`,
`4:3`, and `3:4`; image-to-video inherits the source aspect ratio. Wan options are
`negative_prompt`, `prompt_extend`, `shot_type` (`single` or `multi`), and `seed`.
Hailuo options are `enable_prompt_expansion` and `fast_pretreatment` (the latter
is unavailable on the Fast model).

```json5
{
  agents: {
    defaults: {
      mediaModels: {
        video: {
          primary: "novita/wan2.6-t2v",
        },
      },
    },
  },
}
```

## When to choose Novita

- Hosted open-weight model access with an OpenAI-compatible API.
- DeepSeek, Kimi, MiniMax, GLM, or Qwen-family routes through a single provider
  account.
- Another hosted fallback path beside DeepInfra, GMI, OpenRouter, or direct
  vendor APIs.
- Provider-side model hosting instead of maintaining LM Studio, Ollama,
  SGLang, or vLLM infrastructure.

Choose a direct vendor provider when you need vendor-native request
parameters or support contracts. Choose a local provider when the model must
run on your own hardware or network boundary.

## Troubleshooting

- `401`/`403`: verify the key in Novita's key management page and re-run
  `openclaw onboard --auth-choice novita-api-key` if the stored profile is
  stale.
- Unknown model errors: use the exact `novita/<route-id>` returned by
  `openclaw models list --provider novita`.
- Slow or failed routes: try another Novita model route, or set Novita as a
  fallback provider for workloads that can tolerate provider-specific
  variance.

## Related

- [Model providers](/concepts/model-providers)
- [Provider directory](/providers/index)
