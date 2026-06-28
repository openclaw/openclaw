---
summary: "Use OpenRouter's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in OpenClaw
  - You want to use OpenRouter for image generation
  - You want to use OpenRouter for music generation
  - You want to use OpenRouter for video generation
title: "OpenRouter"
---

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Getting started

<Tabs>
  <Tab title="OAuth">
    <Steps>
      <Step title="Run OAuth onboarding">
        ```bash
        openclaw onboard --auth-choice openrouter-oauth
        ```

        OpenClaw opens OpenRouter's browser sign-in flow, exchanges the PKCE
        code for an OpenRouter API key, and stores that key in the default
        OpenRouter auth profile. On remote/headless hosts, OpenClaw prints the
        sign-in URL and asks you to paste the redirect URL after signing in.
      </Step>
      <Step title="(Optional) Switch to a specific model">
        Onboarding defaults to `openrouter/auto`. Pick a concrete model later:

        ```bash
        openclaw models set openrouter/<provider>/<model>
        ```

      </Step>
    </Steps>

  </Tab>
  <Tab title="API key">
    <Steps>
      <Step title="Get your API key">
        Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
      </Step>
      <Step title="Run API-key onboarding">
        ```bash
        openclaw onboard --auth-choice openrouter-api-key
        ```
      </Step>
      <Step title="(Optional) Switch to a specific model">
        Onboarding defaults to `openrouter/auto`. Pick a concrete model later:

        ```bash
        openclaw models set openrouter/<provider>/<model>
        ```

      </Step>
    </Steps>

  </Tab>
</Tabs>

## Config example

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/auto" },
    },
  },
}
```

## Model references

<Note>
Model refs follow the pattern `openrouter/<provider>/<model>`. For the full list of
available providers and models, see [/concepts/model-providers](/concepts/model-providers).
</Note>

Bundled fallback examples:

| Model ref                         | Notes                        |
| --------------------------------- | ---------------------------- |
| `openrouter/auto`                 | OpenRouter automatic routing |
| `openrouter/openrouter/fusion`    | OpenRouter Fusion router     |
| `openrouter/moonshotai/kimi-k2.6` | Kimi K2.6 via MoonshotAI     |
| `openrouter/moonshotai/kimi-k2.5` | Kimi K2.5 via MoonshotAI     |

## Image generation

OpenRouter can also back the `image_generate` tool. Use an OpenRouter image model under `agents.defaults.imageGenerationModel`:

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openrouter/google/gemini-3.1-flash-image-preview",
        timeoutMs: 180_000,
      },
    },
  },
}
```

OpenClaw sends image requests to OpenRouter's chat completions image API with `modalities: ["image", "text"]`. Gemini image models receive supported `aspectRatio` and `resolution` hints through OpenRouter's `image_config`. Use `agents.defaults.imageGenerationModel.timeoutMs` for slower OpenRouter image models; the `image_generate` tool's per-call `timeoutMs` parameter still wins.

The bundled OpenRouter image provider exposes a curated set of OpenRouter
image-output models, including `google/gemini-3.1-flash-image`,
`google/gemini-3-pro-image`, `google/gemini-2.5-flash-image`,
`openai/gpt-5-image`, `openai/gpt-5-image-mini`, and
`openai/gpt-5.4-image-2`. Existing preview model refs remain accepted when
you have already configured them.

## Video generation

OpenRouter can also back the `video_generate` tool through its asynchronous `/videos` API. Use an OpenRouter video model under `agents.defaults.videoGenerationModel`:

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "openrouter/google/veo-3.1-fast",
      },
    },
  },
}
```

OpenClaw submits text-to-video and image-to-video jobs to OpenRouter, polls
the returned `polling_url`, and downloads the completed video from
OpenRouter's `unsigned_urls` or the documented job content endpoint.
Reference images are sent as first/last frame images by default; images
tagged with `reference_image` are sent as OpenRouter input references. The
bundled `google/veo-3.1-fast` default advertises the currently supported 4/6/8
second durations, `720P`/`1080P` resolutions, and `16:9`/`9:16` aspect
ratios. Video-to-video is not registered for OpenRouter because the upstream
video generation API currently accepts text and image references.

## Music generation

OpenRouter can also back the `music_generate` tool through chat completions
audio output. Use an OpenRouter audio model under
`agents.defaults.musicGenerationModel`:

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "openrouter/google/lyria-3-pro-preview",
        timeoutMs: 180_000,
      },
    },
  },
}
```

The bundled OpenRouter music provider defaults to
`google/lyria-3-pro-preview` and also exposes
`google/lyria-3-clip-preview`. OpenClaw sends `modalities: ["text",
"audio"]`, enables streaming, collects the streamed audio chunks, and saves
the result as generated media for channel delivery. Reference images are
accepted for Lyria models through the shared `music_generate image=...`
parameter.

## Text-to-speech

OpenRouter can also be used as a TTS provider through its OpenAI-compatible
`/audio/speech` endpoint.

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openrouter",
      providers: {
        openrouter: {
          model: "hexgrad/kokoro-82m",
          speakerVoice: "af_alloy",
          responseFormat: "mp3",
        },
      },
    },
  },
}
```

If `messages.tts.providers.openrouter.apiKey` is omitted, TTS reuses
`models.providers.openrouter.apiKey`, then `OPENROUTER_API_KEY`.

## Speech-to-text (inbound audio)

OpenRouter can transcribe inbound voice/audio attachments through the shared
`tools.media.audio` path using its STT endpoint (`/audio/transcriptions`).
This applies to any channel plugin that forwards inbound voice/audio into
media understanding preflight.

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "openrouter", model: "openai/whisper-large-v3-turbo" }],
      },
    },
  },
}
```

OpenClaw sends OpenRouter STT requests as JSON with base64 audio under
`input_audio` (OpenRouter STT contract), not as multipart OpenAI form uploads.

## Fusion router

Use OpenRouter Fusion when you want one OpenClaw model ref to ask several
OpenRouter models in parallel, have OpenRouter judge their answers, and return a
single final response through the normal OpenRouter provider endpoint. Because
the upstream model slug is `openrouter/fusion`, the OpenClaw model ref includes
both the OpenClaw provider prefix and the upstream OpenRouter namespace:

```bash
openclaw models set openrouter/openrouter/fusion
```

Configure Fusion's panel and judge through the model's `params.extraBody`. Those
fields are forwarded into the OpenRouter chat-completions request body. Fusion
works with either OpenRouter OAuth onboarding or API-key onboarding; if you use
OAuth, omit the `env.OPENROUTER_API_KEY` line from the example below.

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/openrouter/fusion" },
      models: {
        "openrouter/openrouter/fusion": {
          params: {
            extraBody: {
              plugins: [
                {
                  id: "fusion",
                  analysis_models: [
                    "google/gemini-3.5-flash",
                    "moonshotai/kimi-k2.6",
                    "deepseek/deepseek-v4-pro",
                  ],
                  model: "google/gemini-3.5-flash",
                },
              ],
            },
          },
        },
      },
    },
  },
}
```

The `analysis_models` list is the parallel panel, and `model` inside the Fusion
plugin config is the judge model. Do not set top-level `tool_choice` to
`"required"` in normal OpenClaw agent/chat turns to try to force Fusion;
OpenClaw turns may include OpenClaw tool definitions, and a top-level required
tool choice can require one of those tools instead of the Fusion router. When
this Fusion plugin config is present, OpenClaw also adds a sanitized
system-prompt note with the configured analysis models and judge model so the
agent can answer questions about its current Fusion panel. Other `extraBody`
fields are not copied into the prompt.

Fusion is slower by design. OpenRouter may send the same OpenClaw prompt to
multiple analysis models and then run a final judge/synthesis step, so latency is
usually higher than a direct single-model request. Use Fusion for deliberate,
high-quality answers or escalation paths, not as the default for
latency-sensitive chat. For faster responses, keep the panel small and choose
faster analysis and judge models.

Test the configured ref with a one-shot local model call:

```bash
openclaw infer model run --local \
  --model openrouter/openrouter/fusion \
  --prompt "Reply with exactly: FUSION_OK" \
  --json
```

## Authentication and headers

OpenRouter uses a Bearer token with your API key under the hood. OpenRouter
OAuth is a PKCE login flow that issues an OpenRouter API key, so OpenClaw stores
the result as the same `openrouter:default` API-key auth profile used by the
manual API-key setup path.

For an existing install, sign in or rotate the stored OpenRouter key without
rerunning full onboarding:

```bash
openclaw models auth login --provider openrouter --method oauth
```

Use `openclaw models auth login --provider openrouter --method api-key` when
you want to paste a key you created manually at OpenRouter.

On real OpenRouter requests (`https://openrouter.ai/api/v1`), OpenClaw also adds
OpenRouter's documented app-attribution headers:

| Header                    | Value                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `HTTP-Referer`            | `https://openclaw.ai`                                                                                  |
| `X-OpenRouter-Title`      | `OpenClaw`                                                                                             |
| `X-OpenRouter-Categories` | `cli-agent,cloud-agent,programming-app,creative-writing,writing-assistant,general-chat,personal-agent` |

<Warning>
If you repoint the OpenRouter provider at some other proxy or base URL, OpenClaw
does **not** inject those OpenRouter-specific headers or Anthropic cache markers.
</Warning>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Response caching">
    OpenRouter response caching is opt-in. Enable it per OpenRouter model with
    model params:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openrouter/auto": {
              params: {
                responseCache: true,
                responseCacheTtlSeconds: 300,
              },
            },
          },
        },
      },
    }
    ```

    OpenClaw sends `X-OpenRouter-Cache: true` and, when configured,
    `X-OpenRouter-Cache-TTL`. `responseCacheClear: true` forces a refresh for
    the current request and stores the replacement response. Snake_case aliases
    (`response_cache`, `response_cache_ttl_seconds`, and
    `response_cache_clear`) are also accepted.

    This is separate from provider prompt caching and from OpenRouter's
    Anthropic `cache_control` markers. It is only applied on verified
    `openrouter.ai` routes, not custom proxy base URLs.

  </Accordion>

  <Accordion title="Anthropic cache markers">
    On verified OpenRouter routes, Anthropic model refs keep the
    OpenRouter-specific Anthropic `cache_control` markers that OpenClaw uses for
    better prompt-cache reuse on system/developer prompt blocks.
  </Accordion>

  <Accordion title="Anthropic reasoning prefill">
    On verified OpenRouter routes, Anthropic model refs with reasoning enabled
    drop trailing assistant prefill turns before the request reaches OpenRouter,
    matching Anthropic's requirement that reasoning conversations end with a user
    turn.
  </Accordion>

  <Accordion title="Thinking / reasoning injection">
    On supported non-`auto` routes, OpenClaw maps the selected thinking level to
    OpenRouter proxy reasoning payloads. Unsupported model hints and
    `openrouter/auto` skip that reasoning injection. Hunter Alpha also skips
    proxy reasoning for stale configured model refs because OpenRouter could
    return final answer text in reasoning fields for that retired route.
  </Accordion>

  <Accordion title="DeepSeek V4 reasoning replay">
    On verified OpenRouter routes, `openrouter/deepseek/deepseek-v4-flash` and
    `openrouter/deepseek/deepseek-v4-pro` fill missing `reasoning_content` on
    replayed assistant turns so thinking/tool conversations keep DeepSeek V4's
    required follow-up shape. OpenClaw sends OpenRouter-supported
    `reasoning_effort` values for these routes; `xhigh` is the highest advertised
    level, and stale `max` overrides are mapped to `xhigh`.
  </Accordion>

  <Accordion title="OpenAI-only request shaping">
    OpenRouter still runs through the proxy-style OpenAI-compatible path, so
    native OpenAI-only request shaping such as `serviceTier`, Responses `store`,
    OpenAI reasoning-compat payloads, and prompt-cache hints is not forwarded.
  </Accordion>

  <Accordion title="Gemini-backed routes">
    Gemini-backed OpenRouter refs stay on the proxy-Gemini path: OpenClaw keeps
    Gemini thought-signature sanitation there, but does not enable native Gemini
    replay validation or bootstrap rewrites.
  </Accordion>

  <Accordion title="Provider routing metadata">
    OpenRouter supports a `provider` request object for underlying provider
    routing. Configure a default policy for all OpenRouter text-model requests
    with `models.providers.openrouter.params.provider`:

    ```json5
    {
      models: {
        providers: {
          openrouter: {
            params: {
              provider: {
                sort: "latency",
                require_parameters: true,
                data_collection: "deny",
              },
            },
          },
        },
      },
    }
    ```

    OpenClaw forwards that object to OpenRouter as the request `provider`
    payload. Use OpenRouter's documented snake_case fields, including `sort`,
    `only`, `ignore`, `order`, `allow_fallbacks`, `require_parameters`,
    `data_collection`, `quantizations`, `max_price`, `preferred_max_latency`,
    `preferred_min_throughput`, `zdr`, and `enforce_distillable_text`.

    Per-model params still override the provider-wide routing object:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openrouter/anthropic/claude-sonnet-4-6": {
              params: {
                provider: {
                  order: ["anthropic"],
                  allow_fallbacks: false,
                },
              },
            },
          },
        },
      },
    }
    ```

    This only applies on OpenRouter chat-completions routes. Direct Anthropic,
    Google, OpenAI, or custom provider routes ignore OpenRouter routing params.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
