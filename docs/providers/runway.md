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

- Provider: `runway`
- Auth: `RUNWAYML_API_SECRET` (canonical; `RUNWAY_API_KEY` also works)
- API: Runway task-based video generation API

## Quick start

1. Set the API key:

```bash
openclaw onboard --auth-choice runway-api-key
```

2. Set a default video model:

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

## Video generation

The bundled `runway` video-generation provider defaults to `runway/gen4.5`.

- Modes: text-to-video, single-image image-to-video, and single-video video-to-video
- Runtime: async task submit + poll via `GET /v1/tasks/{id}`
- Local image/video references: supported via data URIs
- Current video-to-video caveat: OpenClaw currently requires `runway/gen4_aleph` for video inputs
- Current text-to-video caveat: OpenClaw currently exposes `16:9` and `9:16` for text-only runs

To use Runway as the default video provider:

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

- [Video Generation](/tools/video-generation)
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
