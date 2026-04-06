---
title: "Prodia"
summary: "Prodia image and video generation setup in OpenClaw"
read_when:
  - You want to use Prodia image or video generation in OpenClaw
  - You need the PRODIA_TOKEN auth flow
  - You want Prodia defaults for image_generate or video_generate
---

# Prodia

OpenClaw ships a bundled `prodia` provider for hosted image and video generation via the Prodia inference API.

- Provider id: `prodia`
- Auth: `PRODIA_TOKEN`
- API: Prodia `/v2/job` synchronous inference endpoint (`https://inference.prodia.com`)

## Quick start

1. Set the API key:

```bash
openclaw onboard --auth-choice prodia-api-key
```

2. Set Prodia as the default video provider:

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "prodia/veo-fast"
```

3. Ask the agent to generate a video or image. Prodia will be used automatically.

## Image generation models

| Short id                      | Prodia job type                                       | Mode          |
| ----------------------------- | ----------------------------------------------------- | ------------- |
| `flux-fast-schnell` (default) | `inference.flux-fast.schnell.txt2img.v2`              | Text-to-image |
| `flux-dev`                    | `inference.flux-2.dev.txt2img.v1` / `img2img.v1`      | Text + edit   |
| `flux-pro`                    | `inference.flux-2.pro.txt2img.v1` / `img2img.v1`      | Text + edit   |
| `flux-max`                    | `inference.flux-2.max.txt2img.v1` / `img2img.v1`      | Text + edit   |
| `flux-flex`                   | `inference.flux-2.flex.txt2img.v1` / `img2img.v1`     | Text + edit   |
| `flux-klein`                  | `inference.flux-2.klein.txt2img.v1` / `img2img.v1`    | Text + edit   |
| `flux-klein-4b`               | `inference.flux-2.klein.4b.txt2img.v1` / `img2img.v1` | Text + edit   |
| `flux-klein-9b`               | `inference.flux-2.klein.9b.txt2img.v1` / `img2img.v1` | Text + edit   |
| `flux-ghibli`                 | `inference.flux-control.dev.ghibli.img2img.v1`        | Edit only     |
| `flux-kontext`                | `inference.flux-fast.dev-kontext.img2img.v1`          | Edit only     |
| `recraft-v4`                  | `inference.recraft.v4.txt2vec.v1`                     | Text-to-SVG   |

## Video generation models

| Short id             | Prodia job type                         | Mode           |
| -------------------- | --------------------------------------- | -------------- |
| `veo-fast` (default) | `inference.veo.fast.txt2vid.v1`         | Text-to-video  |
| `veo-fast`           | `inference.veo.fast.img2vid.v1`         | Image-to-video |
| `wan2.2-lightning`   | `inference.wan2-2.lightning.txt2vid.v0` | Text-to-video  |
| `wan2.2-lightning`   | `inference.wan2-2.lightning.img2vid.v0` | Image-to-video |
| `seedance-lite`      | `inference.seedance.lite.img2vid.v1`    | Image-to-video |
| `seedance-pro`       | `inference.seedance.pro.img2vid.v1`     | Image-to-video |

- `veo-fast` supports both text-to-video and image-to-video.
- `wan2.2-lightning` supports text-to-video and image-to-video with optional `resolution` (`480P`, `720P`, `1080P`).
- `seedance-lite` and `seedance-pro` support image-to-video only.
- Video-to-video is not supported by any Prodia model.

## Configuration

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "prodia/veo-fast",
      },
      imageGenerationModel: {
        primary: "prodia/flux-fast-schnell",
      },
    },
  },
}
```

## Related

- [Video Generation](/tools/video-generation) -- shared tool parameters, provider selection, and async behavior
- [Image Generation](/tools/image-generation) -- shared tool parameters and provider selection
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
