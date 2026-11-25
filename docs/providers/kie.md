---
summary: "Kie AI video generation setup and supported models"
title: "Kie AI"
read_when:
  - You want to generate videos through Kie AI
  - You need KIE_API_KEY setup or supported video models
---

OpenClaw includes the bundled `kie` plugin, enabled by default, for
[Kie AI](https://kie.ai) video generation.

| Property        | Value                         |
| --------------- | ----------------------------- |
| Provider id     | `kie`                         |
| Auth env var    | `KIE_API_KEY`                 |
| Onboarding flag | `--auth-choice kie-api-key`   |
| Direct CLI flag | `--kie-api-key <key>`         |
| Base URL        | `https://api.kie.ai`          |
| Default model   | `kie/kling-2.6/text-to-video` |

## Setup

Run onboarding or set the environment variable:

```bash
openclaw onboard --auth-choice kie-api-key
```

```bash
export KIE_API_KEY="example-kie-key-not-real"
```

## Video generation

Kie supports text-to-video and image-to-video, with one video per request.
Choose a model using its full `kie/<model>` reference:

| Family           | Text-to-video model                 | Image-to-video model                 |
| ---------------- | ----------------------------------- | ------------------------------------ |
| Grok Imagine     | `grok-imagine/text-to-video`        | `grok-imagine/image-to-video`        |
| Hailuo 02        | `hailuo/02-text-to-video-standard`  | `hailuo/02-image-to-video-standard`  |
| Hailuo 02 Pro    | `hailuo/02-text-to-video-pro`       | `hailuo/02-image-to-video-pro`       |
| Hailuo 2.3       | -                                   | `hailuo/2-3-image-to-video-standard` |
| Hailuo 2.3 Pro   | -                                   | `hailuo/2-3-image-to-video-pro`      |
| Kling 2.6        | `kling-2.6/text-to-video` (default) | `kling-2.6/image-to-video`           |
| Seedance 1.5 Pro | `bytedance/seedance-1.5-pro`        | `bytedance/seedance-1.5-pro`         |
| Wan 2.6          | `wan/2-6-text-to-video`             | `wan/2-6-image-to-video`             |

For paired models, adding one reference image automatically switches to
the matching image-to-video model; omitting it selects the text-to-video
model. Hailuo 2.3 models always require an image. Seedance uses the same
model id for both modes.

| Family           | Duration (seconds) | Resolution controls                        | Audio toggle |
| ---------------- | ------------------ | ------------------------------------------ | ------------ |
| Grok Imagine     | 6–30               | `480P`, `720P`, `1080P`                    | No           |
| Hailuo 02        | 6 or 10            | Image mode: `512P`, `768P`                 | No           |
| Hailuo 02 Pro    | Provider-managed   | Provider-managed                           | No           |
| Hailuo 2.3 / Pro | 6 or 10            | `768P`, `1080P` (1080P requires 6 seconds) | No           |
| Kling 2.6        | 5 or 10            | Provider-managed                           | Yes          |
| Seedance 1.5 Pro | 4–12               | `480P`, `720P`, `1080P`                    | Yes          |
| Wan 2.6          | 5, 10, or 15       | `720P`, `1080P`                            | No           |

Aspect-ratio controls are available for text-only Kling and Grok models,
and both Seedance modes. Run `video_generate action=list` for the model's
supported controls. Kling and Seedance default to no generated audio.

Reference images can be remote HTTP(S) URLs or local files. OpenClaw
uploads local images through Kie's base64 file upload API and passes the
returned URL to generation. This initial plugin supports one image up to
10 MB: JPEG or PNG for Kling; JPEG, PNG, or WebP for the other models.
Video-to-video and audio reference inputs are not supported.

Set the default video model:

```json5
{
  agents: {
    defaults: {
      mediaModels: {
        video: {
          primary: "kie/kling-2.6/text-to-video",
        },
      },
    },
  },
}
```

Kie jobs can take several minutes. OpenClaw polls until completion and
waits up to ten minutes by default. Override this with
`agents.defaults.mediaModels.video.timeoutMs` when needed. Provider error
messages are surfaced even when Kie returns HTTP 200.

Veo is not included yet; its dedicated and market API contracts need to be
reconciled before support is added.

## Live testing

The shared video smoke supports Kie. Allow time for the provider queue:

```bash
OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS=600000 \
  pnpm test:live:media video --video-providers kie
```

Set `OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1` to also exercise local
image upload and image-to-video generation.

## Related

- [Kie API documentation](https://docs.kie.ai)
- [Video generation](/tools/video-generation)
- [Provider directory](/providers/index)
