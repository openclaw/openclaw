---
summary: "Generate music or audio with plugin-provided tools such as ComfyUI workflows"
read_when:
  - Generating music or audio via the agent
  - Configuring plugin-provided music generation tools
  - Understanding the music_generate tool parameters
title: "Music Generation"
---

# Music Generation

The `music_generate` tool lets the agent create audio files when a plugin
registers music generation support.

The bundled `comfy` plugin currently provides `music_generate` using a
workflow-configured ComfyUI graph.

## Quick start

1. Configure `models.providers.comfy.music` with a workflow JSON and prompt/output nodes.
2. If you use Comfy Cloud, set `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY`.
3. Ask the agent for music or call the tool directly.

Example:

```text
/tool music_generate prompt="Warm ambient synth loop with soft tape texture"
```

## Tool parameters

| Parameter  | Type   | Description                                         |
| ---------- | ------ | --------------------------------------------------- |
| `prompt`   | string | Music or audio generation prompt                    |
| `action`   | string | `"generate"` (default) or `"list"`                  |
| `model`    | string | Provider/model override. Currently `comfy/workflow` |
| `filename` | string | Output filename hint for the saved audio file       |

## Current provider support

| Provider | Model      | Notes                           |
| -------- | ---------- | ------------------------------- |
| ComfyUI  | `workflow` | Workflow-defined music or audio |

## Live test

Opt-in live coverage for the bundled ComfyUI music path:

```bash
OPENCLAW_LIVE_TEST=1 COMFY_LIVE_TEST=1 pnpm test:live -- extensions/comfy/comfy.live.test.ts
```

The live file also covers comfy image and video workflows when those sections
are configured.

## Related

- [ComfyUI](/providers/comfy)
- [Tools Overview](/tools)
