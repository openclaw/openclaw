---
title: "Vidu"
summary: "Vidu video generation setup in OpenClaw"
read_when:
  - You want to use Vidu video generation in OpenClaw
  - You need the Vidu API key/env setup
  - You want to make Vidu the default video provider
---

# Vidu

OpenClaw ships a bundled `vidu` provider for hosted video generation.

- Provider id: `vidu`
- Auth: `VIDU_API_KEY` (header format: `Authorization: Token {key}`)
- API: Vidu task-based video generation (polling via `GET /ent/v2/tasks/{id}/creations`)
- Endpoints: Global (`api.vidu.com`) and China (`api.vidu.cn`)

## Quick start

1. Set the API key (choose your region):

```bash
# Global (api.vidu.com)
openclaw onboard --auth-choice vidu-api-key

# China (api.vidu.cn)
openclaw onboard --auth-choice vidu-api-key-cn
```

2. Set Vidu as the default video provider:

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "vidu/viduq3-pro"
```

3. Ask the agent to generate a video. Vidu will be used automatically.

## Supported modes

| Mode               | Endpoint                  | Reference input                       |
| ------------------ | ------------------------- | ------------------------------------- |
| Text-to-video      | `/ent/v2/text2video`      | None                                  |
| Image-to-video     | `/ent/v2/img2video`       | 1 image (first frame)                 |
| Start-end-to-video | `/ent/v2/start-end2video` | 2 images (start frame + end frame)    |
| Reference-to-video | `/ent/v2/reference2video` | 1-7 images, 1-2 videos (multi-entity) |

- Local image references are supported via base64 data URIs.
- Image-to-video uses a single first-frame image.
- Start-end-to-video interpolates between a start frame and an end frame. Pass `role: "first_frame"` and `role: "last_frame"` on the input images, or supply exactly 2 images without roles (defaults to start-end).
- Reference-to-video supports multi-entity consistency with 1-7 reference images per subject, up to 7 subjects. Video references (1-2 videos, `viduq2-pro` only) are also supported. When videos are present, non-subject mode is used with separate `images` and `videos` arrays. Pass `role: "reference_image"` on input images, or supply 3+ images (auto-detected as reference mode). Each image becomes a separate subject.

## Available models

| Model                  | Text-to-video | Image-to-video | Start-end-to-video | Reference-to-video | Max duration | Notes                       |
| ---------------------- | ------------- | -------------- | ------------------ | ------------------ | ------------ | --------------------------- |
| `viduq3-pro` (default) | Yes           | Yes            | Yes                | No                 | 16s          | Best quality, audio support |
| `viduq3-turbo`         | Yes           | Yes            | Yes                | No                 | 16s          | Faster generation           |
| `viduq2-pro`           | No            | Yes            | Yes                | Yes                | 10s          | Video editing support       |
| `viduq2-pro-fast`      | No            | Yes            | Yes                | No                 | 10s          | Fast, stable                |
| `viduq2-turbo`         | No            | Yes            | Yes                | No                 | 10s          | Fast generation             |
| `viduq2`               | Yes           | No             | No                 | Yes                | 10s          | Rich details                |
| `viduq1`               | Yes           | Yes            | Yes                | Yes                | 5s           | Clear, stable               |
| `viduq1-classic`       | No            | Yes            | Yes                | No                 | 5s           | Rich transitions            |
| `vidu2.0`              | No            | Yes            | Yes                | Yes                | 8s           | Fast generation             |

## Supported parameters

| Parameter      | Description                                                 |
| -------------- | ----------------------------------------------------------- |
| `prompt`       | Text description for video generation (max 5000 characters) |
| `duration`     | Duration in seconds (range depends on model)                |
| `resolution`   | `540p`, `720p`, or `1080p` (availability depends on model)  |
| `aspect_ratio` | `16:9`, `9:16`, `3:4`, `4:3`, or `1:1`                      |
| `audio`        | Audio generation toggle (q3 models default to `true`)       |
| `watermark`    | Watermark toggle (default `false`)                          |

## Configuration

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "vidu/viduq3-pro",
      },
    },
  },
}
```

To use the China endpoint, set the base URL via onboarding (`openclaw onboard --auth-choice vidu-api-key-cn`) or manually:

```json5
{
  models: {
    providers: {
      vidu: {
        baseUrl: "https://api.vidu.cn",
      },
    },
  },
}
```

## Environment variables

| Variable       | Description                                    |
| -------------- | ---------------------------------------------- |
| `VIDU_API_KEY` | Vidu API key (works for both Global and China) |

## Related

- [Video Generation](/tools/video-generation) -- shared tool parameters, provider selection, and async behavior
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
