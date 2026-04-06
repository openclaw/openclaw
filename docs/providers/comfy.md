---
title: "ComfyUI"
summary: "ComfyUI workflow image, video, and music generation setup in OpenClaw"
read_when:
  - You want to use local ComfyUI workflows with OpenClaw
  - You want to use Comfy Cloud with image, video, or music workflows
  - You need the bundled comfy plugin config keys
---

# ComfyUI

OpenClaw ships a bundled `comfy` plugin for workflow-driven ComfyUI runs.

- Provider: `comfy`
- Models: `comfy/workflow`
- Shared surfaces: `image_generate`, `video_generate`, `music_generate`
- Auth: none for local ComfyUI; `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` for Comfy Cloud
- API: ComfyUI `/prompt` / `/history` / `/view` and Comfy Cloud `/api/*`

## What it supports

- Image generation from a workflow JSON
- Image editing with 1 uploaded reference image
- Video generation from a workflow JSON
- Video generation with 1 uploaded reference image
- Music or audio generation through the shared `music_generate` tool
- Output download from a configured node or all matching output nodes

The bundled plugin is workflow-driven, so OpenClaw does not try to map generic
`size`, `aspectRatio`, `resolution`, `durationSeconds`, or TTS-style controls
onto your graph.

## Config layout

Comfy supports shared top-level connection settings plus per-capability workflow
sections:

```json5
{
  models: {
    providers: {
      comfy: {
        mode: "local",
        baseUrl: "http://127.0.0.1:8188",
        image: {
          workflowPath: "./workflows/flux-api.json",
          promptNodeId: "6",
          outputNodeId: "9",
        },
        video: {
          workflowPath: "./workflows/video-api.json",
          promptNodeId: "12",
          outputNodeId: "21",
        },
        music: {
          workflowPath: "./workflows/music-api.json",
          promptNodeId: "3",
          outputNodeId: "18",
        },
      },
    },
  },
}
```

Shared keys:

- `mode`: `local` or `cloud`
- `baseUrl`: defaults to `http://127.0.0.1:8188` for local or `https://cloud.comfy.org` for cloud
- `apiKey`: optional inline key alternative to env vars
- `allowPrivateNetwork`: allow a private/LAN `baseUrl` in cloud mode

Per-capability keys under `image`, `video`, or `music`:

- `workflow` or `workflowPath`: required
- `promptNodeId`: required
- `promptInputName`: defaults to `text`
- `outputNodeId`: optional
- `pollIntervalMs`: optional
- `timeoutMs`: optional

Image and video sections also support:

- `inputImageNodeId`: required when you pass a reference image
- `inputImageInputName`: defaults to `image`

## Backward compatibility

Existing top-level image config still works:

```json5
{
  models: {
    providers: {
      comfy: {
        workflowPath: "./workflows/flux-api.json",
        promptNodeId: "6",
        outputNodeId: "9",
      },
    },
  },
}
```

OpenClaw treats that legacy shape as the image workflow config.

## Image workflows

Set the default image model:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "comfy/workflow",
      },
    },
  },
}
```

Reference-image editing example:

```json5
{
  models: {
    providers: {
      comfy: {
        image: {
          workflowPath: "./workflows/edit-api.json",
          promptNodeId: "6",
          inputImageNodeId: "7",
          inputImageInputName: "image",
          outputNodeId: "9",
        },
      },
    },
  },
}
```

## Video workflows

Set the default video model:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "comfy/workflow",
      },
    },
  },
}
```

Comfy video workflows currently support text-to-video and image-to-video through
the configured graph. OpenClaw does not pass input videos into Comfy workflows.

## Music workflows

The bundled plugin registers a music-generation provider for workflow-defined
audio or music outputs, surfaced through the shared `music_generate` tool:

```text
/tool music_generate prompt="Warm ambient synth loop with soft tape texture"
```

Use the `music` config section to point at your audio workflow JSON and output
node.

## Comfy Cloud

Use `mode: "cloud"` plus one of:

- `COMFY_API_KEY`
- `COMFY_CLOUD_API_KEY`
- `models.providers.comfy.apiKey`

Cloud mode still uses the same `image`, `video`, and `music` workflow sections.

## Live tests

Opt-in live coverage exists for the bundled plugin:

```bash
OPENCLAW_LIVE_TEST=1 COMFY_LIVE_TEST=1 pnpm test:live -- extensions/comfy/comfy.live.test.ts
```

The live test skips individual image, video, or music cases unless the matching
Comfy workflow section is configured.

## Related

- [Image Generation](/tools/image-generation)
- [Video Generation](/tools/video-generation)
- [Music Generation](/tools/music-generation)
- [Provider Directory](/providers/index)
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
