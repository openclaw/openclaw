---
summary: "Generate videos from text, images, or existing videos using 10 provider backends"
read_when:
  - Generating videos via the agent
  - Configuring video generation providers and models
  - Understanding the video_generate tool parameters
title: "Video Generation"
---

# Video Generation

OpenClaw agents can generate videos from text prompts, reference images, or existing videos. Ten provider backends are supported, each with different model options, input modes, and feature sets. The agent picks the right provider automatically based on your configuration and available API keys.

<Note>
The `video_generate` tool only appears when at least one video-generation provider is available. If you do not see it in your agent tools, set a provider API key or configure `agents.defaults.videoGenerationModel`.
</Note>

## Quick start

1. Set an API key for any supported provider:

```bash
export GEMINI_API_KEY="your-key"
```

2. Optionally pin a default model:

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "google/veo-3.1-fast-generate-preview"
```

3. Ask the agent:

> Generate a 5-second cinematic video of a friendly lobster surfing at sunset.

The agent calls `video_generate` automatically. No tool allowlisting is needed.

## What happens when you generate a video

Video generation is asynchronous. When the agent calls `video_generate` in a session:

1. OpenClaw submits the request to the provider and immediately returns a task ID.
2. The provider processes the job in the background (typically 30 seconds to 5 minutes depending on the provider and resolution).
3. When the video is ready, OpenClaw wakes the same session with an internal completion event.
4. The agent posts the finished video back into the original conversation.

While a job is in flight, duplicate `video_generate` calls in the same session return the current task status instead of starting another generation. Use `openclaw tasks list` or `openclaw tasks show <taskId>` to check progress from the CLI.

Outside of session-backed agent runs (for example, direct tool invocations), the tool falls back to inline generation and returns the final media path in the same turn.

## Supported providers

| Provider              | Default model                   | Text | Image ref                                            | Video ref        | API key               |
| --------------------- | ------------------------------- | ---- | ---------------------------------------------------- | ---------------- | --------------------- |
| Alibaba               | `wan2.6-t2v`                    | Yes  | Yes (remote URL)                                     | Yes (remote URL) | `MODELSTUDIO_API_KEY` |
| BytePlus (1.0)        | `seedance-1-0-pro-250528`       | Yes  | Up to 2 images (I2V models only; first + last frame) | No               | `BYTEPLUS_API_KEY`    |
| BytePlus Seedance 1.5 | `seedance-1-5-pro-251215`       | Yes  | Up to 2 images (first + last frame via role)         | No               | `BYTEPLUS_API_KEY`    |
| BytePlus Seedance 2.0 | `dreamina-seedance-2-0-260128`  | Yes  | Up to 9 reference images                             | Up to 3 videos   | `BYTEPLUS_API_KEY`    |
| fal                   | `fal-ai/minimax/video-01-live`  | Yes  | 1 image                                              | No               | `FAL_KEY`             |
| Google                | `veo-3.1-fast-generate-preview` | Yes  | 1 image                                              | 1 video          | `GEMINI_API_KEY`      |
| MiniMax               | `MiniMax-Hailuo-2.3`            | Yes  | 1 image                                              | No               | `MINIMAX_API_KEY`     |
| OpenAI                | `sora-2`                        | Yes  | 1 image                                              | 1 video          | `OPENAI_API_KEY`      |
| Qwen                  | `wan2.6-t2v`                    | Yes  | Yes (remote URL)                                     | Yes (remote URL) | `QWEN_API_KEY`        |
| Runway                | `gen4.5`                        | Yes  | 1 image                                              | 1 video          | `RUNWAYML_API_SECRET` |
| Together              | `Wan-AI/Wan2.2-T2V-A14B`        | Yes  | 1 image                                              | No               | `TOGETHER_API_KEY`    |
| xAI                   | `grok-imagine-video`            | Yes  | 1 image                                              | 1 video          | `XAI_API_KEY`         |

Some providers accept additional or alternate API key env vars. See individual [provider pages](#related) for details.

Run `video_generate action=list` to inspect available providers and models at runtime.

## Tool parameters

### Required

| Parameter | Type   | Description                                                                   |
| --------- | ------ | ----------------------------------------------------------------------------- |
| `prompt`  | string | Text description of the video to generate (required for `action: "generate"`) |

### Content inputs

| Parameter    | Type     | Description                                                                                              |
| ------------ | -------- | -------------------------------------------------------------------------------------------------------- |
| `image`      | string   | Single reference image (path or URL)                                                                     |
| `images`     | string[] | Multiple reference images (up to 9)                                                                      |
| `imageRoles` | string[] | Parallel semantic roles for `images` entries (e.g. `"first_frame"`, `"last_frame"`, `"reference_image"`) |
| `video`      | string   | Single reference video (path or URL)                                                                     |
| `videos`     | string[] | Multiple reference videos (up to 4)                                                                      |
| `audioRef`   | string   | Single reference audio URL (e.g. background music)                                                       |
| `audioRefs`  | string[] | Multiple reference audios (up to 3; provider-dependent)                                                  |

### Style controls

| Parameter         | Type    | Description                                                              |
| ----------------- | ------- | ------------------------------------------------------------------------ |
| `aspectRatio`     | string  | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`  |
| `resolution`      | string  | `480P`, `720P`, or `1080P`                                               |
| `durationSeconds` | number  | Target duration in seconds (rounded to nearest provider-supported value) |
| `size`            | string  | Size hint when the provider supports it                                  |
| `audio`           | boolean | Enable generated audio when supported                                    |
| `watermark`       | boolean | Toggle provider watermarking when supported                              |

### Advanced

| Parameter         | Type   | Description                                                                                                                                           |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`          | string | `"generate"` (default), `"status"`, or `"list"`                                                                                                       |
| `model`           | string | Provider/model override (e.g. `runway/gen4.5`)                                                                                                        |
| `filename`        | string | Output filename hint                                                                                                                                  |
| `providerOptions` | object | Provider-specific options passed as-is to the active provider. Core does not validate the contents. See individual provider pages for supported keys. |

Not all providers support all parameters. Unsupported overrides are ignored on a best-effort basis and reported as warnings in the tool result. Hard capability limits (such as too many reference inputs) fail before submission.

## Actions

- **generate** (default) -- create a video from the given prompt and optional reference inputs.
- **status** -- check the state of the in-flight video task for the current session without starting a new one.
- **list** -- show available providers, models, and their capabilities.

## Model selection

When generating a video, OpenClaw resolves the model in this order:

1. **`model` tool parameter** -- if the agent specifies one in the call.
2. **`videoGenerationModel.primary`** -- from config.
3. **`videoGenerationModel.fallbacks`** -- tried in order.
4. **Auto-detection** -- uses providers that have valid auth, starting with the current default provider, then remaining providers in alphabetical order.

If a provider fails, the next candidate is tried automatically. If all candidates fail, the error includes details from each attempt.

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "google/veo-3.1-fast-generate-preview",
        fallbacks: ["runway/gen4.5", "qwen/wan2.6-t2v"],
      },
    },
  },
}
```

## Provider notes

| Provider              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alibaba               | Uses DashScope/Model Studio async endpoint. Reference images and videos must be remote `http(s)` URLs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| BytePlus (1.0)        | Provider id `byteplus`. Models: `seedance-1-0-pro-250528` (default), `seedance-1-0-pro-t2v-250528`, `seedance-1-0-pro-fast-251015`, `seedance-1-0-lite-t2v-250428`, `seedance-1-0-lite-i2v-250428`. T2V models (`*-t2v-*`) do not accept image inputs; I2V models (`*-i2v-*`) and general `*-pro-*` models support first + last frame (up to 2 images). Pass positionally or set `role: "first_frame"` / `"last_frame"` on each asset, or use `providerOptions.firstFrameImageUrl` / `providerOptions.lastFrameImageUrl`. Additional `providerOptions` keys: `seed` (number), `draft` (boolean, forces 480p), `camerafixed` (boolean). Returns a pre-signed URL directly; no buffer download. |
| BytePlus Seedance 1.5 | Provider id `byteplus-seedance15`. Uses the unified `content[]` API. Supports at most 2 input images (first_frame + last_frame). All inputs must be remote `https://` URLs. Set `role: "first_frame"` / `"last_frame"` on each image, or pass images positionally. `aspectRatio: "adaptive"` auto-detects ratio from the input image. `audio: true` maps to `generate_audio`. `providerOptions.seed` (number) is forwarded.                                                                                                                                                                                                                                                                   |
| BytePlus Seedance 2.0 | Provider id `byteplus-seedance2`. Uses the unified `content[]` API. Supports up to 9 reference images, 3 reference videos, and 3 reference audios. All inputs must be remote `https://` URLs. Set `role` on each asset — supported values: `"first_frame"`, `"last_frame"`, `"reference_image"`, `"reference_video"`, `"reference_audio"`. `aspectRatio: "adaptive"` auto-detects ratio from the input image. `audio: true` maps to `generate_audio`. `providerOptions.seed` (number) is forwarded.                                                                                                                                                                                           |
| fal                   | Uses queue-backed flow for long-running jobs. Single image reference only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Google                | Uses Gemini/Veo. Supports one image or one video reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| MiniMax               | Single image reference only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| OpenAI                | Only `size` override is forwarded. Other style overrides (`aspectRatio`, `resolution`, `audio`, `watermark`) are ignored with a warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Qwen                  | Same DashScope backend as Alibaba. Reference inputs must be remote `http(s)` URLs; local files are rejected upfront.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Runway                | Supports local files via data URIs. Video-to-video requires `runway/gen4_aleph`. Text-only runs expose `16:9` and `9:16` aspect ratios.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Together              | Single image reference only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| xAI                   | Supports text-to-video, image-to-video, and remote video edit/extend flows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Configuration

Set the default video generation model in your OpenClaw config:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "qwen/wan2.6-t2v",
        fallbacks: ["qwen/wan2.6-r2v-flash"],
      },
    },
  },
}
```

Or via the CLI:

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "qwen/wan2.6-t2v"
```

## Related

- [Tools Overview](/tools)
- [Background Tasks](/automation/tasks) -- task tracking for async video generation
- [Alibaba Model Studio](/providers/alibaba)
- [BytePlus](/providers/byteplus)
- [fal](/providers/fal)
- [Google (Gemini)](/providers/google)
- [MiniMax](/providers/minimax)
- [OpenAI](/providers/openai)
- [Qwen](/providers/qwen)
- [Runway](/providers/runway)
- [Together AI](/providers/together)
- [xAI](/providers/xai)
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
- [Models](/concepts/models)
