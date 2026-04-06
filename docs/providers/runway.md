---
title: "Runway"
summary: "Runway video generation setup in OpenClaw"
read_when:
  - You want to use Runway video generation in OpenClaw
  - You need the Runway API key/env setup
  - You want to make Runway the default video provider
---

# Runway

OpenClaw ships a bundled `runway` provider for hosted video generation.

- Provider id: `runway`
- Auth: `RUNWAYML_API_SECRET` (canonical) or `RUNWAY_API_KEY`
- API: Runway task-based video generation (`GET /v1/tasks/{id}` polling)

## Quick start

1. Set the API key:

```bash
openclaw onboard --auth-choice runway-api-key
```

2. Set Runway as the default video provider:

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "runway/gen4.5"
```

3. Ask the agent to generate a video. Runway will be used automatically.

## Supported modes

| Mode           | Model              | Reference input         |
| -------------- | ------------------ | ----------------------- |
| Text-to-video  | `gen4.5` (default) | None                    |
| Image-to-video | `gen4.5`           | 1 local or remote image |
| Video-to-video | `gen4_aleph`       | 1 local or remote video |

- Local image and video references are supported via data URIs.
- Video-to-video currently requires `runway/gen4_aleph` specifically.
- Text-only runs currently expose `16:9` and `9:16` aspect ratios.

## Configuration

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "runway/gen4.5",
      },
    },
  },
}
```

## Related

- [Video Generation](/tools/video-generation) -- shared tool parameters, provider selection, and async behavior
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
