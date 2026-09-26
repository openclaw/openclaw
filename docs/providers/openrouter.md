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

OpenRouter routes requests to many models behind one API and one key. Its chat routes are
OpenAI-compatible, so OpenClaw uses the same `openai-completions`-style transport
as other proxy providers. Typed decision models use the separate native System
One API, not chat completions.

## Getting started

In a private chat, send `/login openrouter` or select OpenRouter from `/login`.
Choose **Sign in with OpenRouter**, approve access in your browser, and return
to chat. OpenClaw receives the browser callback and saves the credential before
reporting success. Use `/login cancel` to cancel a pending sign-in.

Login saves access without choosing a starter model. If current model restrictions
hide OpenRouter models, choose **Show all OpenRouter models** or **Keep current
restrictions**. The credential stays saved either way. In the Control UI, use
**Settings → Models → Connect** for the same credential-only flow, then use the
model menu to choose a model from the Gateway's catalog.

Chat browser sign-in uses the Gateway's managed [Tailscale HTTPS address](/gateway/tailscale).
With Tailscale Serve, your browser must have access to the same tailnet. If no
managed HTTPS address is available, enable Serve and retry, or use the CLI flow
below. The callback does not sign you in to the Control UI.

The Control UI receives the return automatically at the managed HTTPS address
or when opened directly on the local Gateway's loopback address and port.
Other addresses use manual redirect completion. If pasted input is incomplete
or invalid, correct it in the same sign-in attempt and submit again.

<Tabs>
  <Tab title="OAuth">
    <Steps>
      <Step title="Run OAuth onboarding">
        ```bash
        openclaw onboard --auth-choice openrouter-oauth
        ```

        OpenClaw opens OpenRouter's browser sign-in flow (PKCE), exchanges the
        code for an OpenRouter API key, and stores it in the default
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
  env: { vars: { OPENROUTER_API_KEY: "sk-or-..." } },
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
providers and models OpenRouter routes to, see [OpenRouter's model catalog](https://openrouter.ai/models).
For how OpenClaw resolves model refs and failover, see [Model selection](/concepts/model-providers).
</Note>

Bundled starter models enrich a nonempty public catalog. A failed live request
reports a discovery failure rather than substituting these rows; a successful
empty response stays empty:

| Model ref                         | Notes                        |
| --------------------------------- | ---------------------------- |
| `openrouter/auto`                 | OpenRouter automatic routing |
| `openrouter/moonshotai/kimi-k2.6` | Kimi K2.6 via MoonshotAI     |
| `openrouter/moonshotai/kimi-k2.5` | Kimi K2.5 via MoonshotAI     |

Any other `openrouter/<provider>/<model>` ref, including
`openrouter/openrouter/fusion` (see [Fusion router](#fusion-router)), resolves
dynamically against OpenRouter's live model catalog.

Discovered models use OpenRouter's advertised tool support. When a model's
`supported_parameters` list omits `tools`, OpenClaw sends requests without tool
definitions or tool choice. Models without that metadata keep the default tool
behavior.

## Typed decisions with Jev

Select Jev as the [decision model](/concepts/decision-models), using your existing
OpenRouter connection and auth profiles. No separate TypeSafe login is needed:

```json5
{
  agents: {
    defaults: { decisionModel: "openrouter/typesafe/jev-1.13" },
  },
}
```

The canonical catalog includes `openrouter/typesafe/jev-1.13` and
`openrouter/~typesafe/jev-latest` as **decision-only** routes. They do not appear as chat
choices, and selecting a decision model does not change your primary or utility
model. The latest alias follows future releases; it is not a version pin.

Jev accepts text or structured JSON objects/arrays and Boolean, Choice, and Score
questions. Supply instructions for every question. Choice supports 2–255 options;
Score supports 2–10 non-null levels. Boolean criteria are optional, but when
provided must describe both true and false. Images, sorting, tags and explicit
reasoning controls are rejected before inference. Omit reasoning or use `auto`.
Jev returns no free-form prose or reasoning trace.

OpenClaw sends one request to `/systemone` appended to the effective OpenRouter
API base URL, including a declared custom proxy path prefix. A `baseUrl` override
alone does not declare native decision support: the owning plugin must publish
that route and protocol in its [manifest model catalog](/plugins/manifest/models#modelcatalog-reference).
Foreign endpoints without that declaration are refused. It preserves normal prepared
auth and provider routing preferences (including privacy restrictions). Unsupported
chat-only parameters are rejected rather than silently dropped. No session IDs,
user identity or trace fields are added to the request body.

The OpenRouter route advertises 32,000 tokens for state plus questions, distinct
from the direct TypeSafe route. Jev 1.13's published input price is $0.042 per
million tokens; output tokens are free. The adapter preserves reported token
counts and actual `usage.cost`, including explicit zero. Missing actual cost stays
missing; the adapter never invents a bill or finalizes usage a second time.

Use `contractVersion: 2` with the `decision_evaluate` core tool and tagged state
(for example, `{ type: "text", text: "Ticket contents" }`). Plugin consumers
should use `api.runtime.decisions.evaluateV2`. Existing V1-only consumers,
including the current Auto decision integration, cannot automatically consume
OpenRouter results carrying native USD billing or provider metadata. Native model identity, upstream provider,
selected labels, fractional scores and rounded distributions remain unchanged.
The legacy V1 adapter succeeds only when the response is representable without
losing billing or metadata; otherwise it returns `unsupported-input` rather than
silently discarding those facts.

The known Jev routes are bounded canonical manifest declarations. The ordinary
live text catalog does not turn `decisions` output rows into synthetic chat
models. See [Jev on OpenRouter](https://openrouter.ai/docs/guides/community/jev)
and the [System One API](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request)
for the upstream contract.

## Image generation

OpenRouter can back the `image_generate` tool. Set an OpenRouter image model
under `agents.defaults.mediaModels.image`:

```json5
{
  env: { vars: { OPENROUTER_API_KEY: "sk-or-..." } },
  agents: {
    defaults: {
      mediaModels: {
        image: {
          primary: "openrouter/google/gemini-3.1-flash-image-preview",
          timeoutMs: 180000,
        },
      },
    },
  },
}
```

OpenClaw sends canonical OpenRouter image requests to the dedicated image API
(`POST /api/v1/images`). Gemini image models additionally receive
`aspect_ratio` and `resolution` hints, and image edits pass source images as
`input_references`. Generated images come back as base64 (`b64_json`) with an
optional `media_type`; when `media_type` is absent, OpenClaw sniffs the image
format from the bytes.

Configured custom OpenRouter `baseUrl` destinations retain the existing
chat-completions image route for compatibility with proxies that do not expose
the dedicated endpoint. Use `agents.defaults.mediaModels.image.timeoutMs` for
slower models; the `image_generate` tool's per-call `timeoutMs` still wins.

## Video generation

OpenRouter can back the `video_generate` tool through its asynchronous
`/videos` API. Set an OpenRouter video model under
`agents.defaults.mediaModels.video`:

```json5
{
  env: { vars: { OPENROUTER_API_KEY: "sk-or-..." } },
  agents: {
    defaults: {
      mediaModels: {
        video: {
          primary: "openrouter/google/veo-3.1-fast",
        },
      },
    },
  },
}
```

OpenClaw submits text-to-video and image-to-video jobs, polls the returned
`polling_url`, and downloads the finished video from OpenRouter's
`unsigned_urls` or the job content endpoint. Reference images default to
first/last-frame images; images tagged `reference_image` are sent as input
references instead. The bundled `google/veo-3.1-fast` default supports 4/6/8
second durations, `720P`/`1080P` resolutions, and `16:9`/`9:16` aspect ratios.
Video-to-video is not supported: the upstream API only accepts text and image
references.

## Music generation

OpenRouter can back the `music_generate` tool through chat-completions audio
output. Set an OpenRouter audio model under
`agents.defaults.mediaModels.music`:

```json5
{
  env: { vars: { OPENROUTER_API_KEY: "sk-or-..." } },
  agents: {
    defaults: {
      mediaModels: {
        music: {
          primary: "openrouter/google/lyria-3-pro-preview",
          timeoutMs: 180000,
        },
      },
    },
  },
}
```

The bundled OpenRouter music provider defaults to `google/lyria-3-pro-preview`
and also exposes `google/lyria-3-clip-preview`. OpenClaw sends `modalities:
["text", "audio"]`, streams the response, collects the audio chunks, and saves
the result as generated media for channel delivery. Lyria models accept one
reference image through the shared `music_generate image=...` parameter.
Streaming audio, transcript retention, and the derived SSE event envelope are
bounded by `agents.defaults.mediaMaxMb` (the default audio cap is 16 MB).

## Text-to-speech

OpenRouter can act as a TTS provider through its OpenAI-compatible
`/audio/speech` endpoint.

```json5
{
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
}
```

If `tts.providers.openrouter.apiKey` is omitted, TTS falls back to
`models.providers.openrouter.apiKey`, then `OPENROUTER_API_KEY`.

## Speech-to-text (inbound audio)

OpenRouter can transcribe inbound voice/audio attachments through the shared
`tools.media.audio` path, using its STT endpoint (`/audio/transcriptions`).
This applies to any channel plugin that forwards inbound voice/audio into
media understanding preflight.

```json5
{
  tools: {
    media: {
      models: [
        {
          provider: "openrouter",
          model: "openai/whisper-large-v3-turbo",
          capabilities: ["audio"],
        },
      ],
      audio: { enabled: true },
    },
  },
}
```

OpenClaw sends OpenRouter STT requests as JSON with base64 audio under
`input_audio` (OpenRouter's STT contract), not as multipart OpenAI form
uploads.

## Fusion router

OpenRouter Fusion sends one OpenClaw model ref to several OpenRouter models in
parallel, has OpenRouter judge their answers, and returns one final response
through the normal OpenRouter endpoint. The upstream model slug is
`openrouter/fusion`, so the OpenClaw model ref carries both the OpenClaw
provider prefix and the upstream OpenRouter namespace:

```bash
openclaw models set openrouter/openrouter/fusion
```

Configure Fusion's panel and judge through the model's `params.extraBody`;
those fields forward directly into the OpenRouter chat-completions request
body. Fusion works with either OAuth or API-key onboarding; if you use OAuth,
omit the `env.vars.OPENROUTER_API_KEY` line below.

```json5
{
  env: { vars: { OPENROUTER_API_KEY: "sk-or-..." } },
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

`analysis_models` is the parallel panel; `model` inside the Fusion plugin
config is the judge model. Do not set top-level `tool_choice` to `"required"`
in normal agent/chat turns to try to force Fusion: OpenClaw turns can include
its own tool definitions, and a top-level required tool choice may pick one of
those instead of the Fusion router. When this Fusion plugin config is present,
OpenClaw adds a sanitized system-prompt note listing the configured analysis
models and judge model, so the agent can answer questions about its own Fusion
panel. Other `extraBody` fields are not copied into the prompt.

Fusion is slower by design: OpenRouter fans the prompt out to multiple
analysis models, then runs a judge/synthesis step, so latency runs higher than
a direct single-model request. Use it for deliberate, high-quality answers or
escalation paths, not as a latency-sensitive default. Keep the panel small and
pick faster analysis/judge models for quicker responses.

Test a configured ref with a one-shot local call:

```bash
openclaw infer model run --local \
  --model openrouter/openrouter/fusion \
  --prompt "Reply with exactly: FUSION_OK" \
  --json
```

## Authentication and headers

OpenRouter uses a Bearer token from your API key. OpenRouter OAuth is a PKCE
login flow that issues an OpenRouter API key, so OpenClaw stores the result in
the same `openrouter:default` API-key auth profile used by manual API-key
setup.

To sign in or rotate the stored key on an existing install without rerunning
full onboarding:

```bash
openclaw models auth login --provider openrouter --method oauth
openclaw models auth login --provider openrouter --method api-key
```

On verified OpenRouter requests (`https://openrouter.ai/api/v1`), OpenClaw adds
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
    OpenRouter response caching is opt-in. Enable it per model:

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
    the current request and stores the replacement response. Snake_case
    aliases (`response_cache`, `response_cache_ttl_seconds`,
    `response_cache_clear`) are accepted, as is `responseCacheTtl` /
    `response_cache_ttl` without the `Seconds` suffix.

    This is separate from provider prompt caching and from OpenRouter's
    Anthropic `cache_control` markers. It only applies on verified
    `openrouter.ai` routes, not custom proxy base URLs.

  </Accordion>

  <Accordion title="Anthropic cache markers">
    On verified OpenRouter routes, Anthropic model refs keep OpenRouter's
    Anthropic `cache_control` markers for better prompt-cache reuse on
    system/developer prompt blocks.
  </Accordion>

  <Accordion title="Anthropic reasoning prefill">
    On verified OpenRouter routes, Anthropic model refs with reasoning enabled
    drop trailing assistant prefill turns before the request reaches
    OpenRouter, matching Anthropic's requirement that reasoning conversations
    end with a user turn.
  </Accordion>

  <Accordion title="Thinking / reasoning injection">
    OpenClaw uses the selected model's advertised reasoning efforts for its
    thinking choices and request payloads. Models that require reasoning omit
    the off choice. Agent turns and standalone completions share these controls
    and reasoning-replay rules. On supported non-`auto` routes, OpenClaw maps the selected thinking level
    to OpenRouter proxy reasoning payloads. `openrouter/auto` and unsupported
    model hints skip that injection. Stale `openrouter/hunter-alpha` refs also
    skip it, because OpenRouter could return final answer text in reasoning
    fields on that retired route.

    Models without an effort selector show on/off controls, or **always on**
    when reasoning is mandatory. These models receive binary reasoning controls
    without a scalar effort. Omitting a thinking request leaves their native
    reasoning default unchanged; configured reasoning budgets are preserved.

  </Accordion>

  <Accordion title="DeepSeek V4 reasoning replay">
    On verified OpenRouter routes, `openrouter/deepseek/deepseek-v4-flash` and
    `openrouter/deepseek/deepseek-v4-pro` fill missing `reasoning_content` on
    replayed assistant turns, keeping thinking/tool conversations in DeepSeek
    V4's required follow-up shape. OpenClaw sends OpenRouter-supported
    `reasoning.effort` values for these routes: `xhigh`/`max` map to `xhigh`,
    every other non-off level maps to `high`. `/think off` explicitly sends
    `reasoning.effort: "none"` and removes reasoning replay fields instead of
    falling back to the provider's reasoning default.
  </Accordion>

  <Accordion title="OpenAI-only request shaping">
    OpenRouter runs through the proxy-style OpenAI-compatible path, so native
    OpenAI-only request shaping such as `serviceTier`, Responses `store`,
    OpenAI reasoning-compat payloads, and prompt-cache hints is not forwarded.
  </Accordion>

  <Accordion title="Gemini-backed routes">
    Gemini-backed OpenRouter refs stay on the proxy-Gemini path: OpenClaw keeps
    Gemini thought-signature sanitation there, but does not enable native
    Gemini replay validation or bootstrap rewrites.
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

    Per-model params override the provider-wide routing object:

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

    This applies on OpenRouter chat-completions and native decision routes. Direct Anthropic,
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
  <Card title="Arcee" href="/providers/arcee" icon="server">
    Arcee models reachable with an OpenRouter key.
  </Card>
  <Card title="Image generation" href="/tools/image-generation" icon="image">
    Shared image tool parameters and provider selection.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="Music generation" href="/tools/music-generation" icon="music">
    Shared music tool parameters and provider selection.
  </Card>
</CardGroup>
