---
summary: "Local ComfyUI generation tool (optional plugin + loopback bridge)"
read_when:
  - You want local image generation from OpenClaw
  - You are wiring ComfyUI + FLUX.1-dev with a tool interface
title: "ComfyUI"
---

# ComfyUI

`comfy_generate` is an **optional plugin tool** that sends structured generation
requests to a local `comfy_bridge.py` sidecar, which then orchestrates ComfyUI.

This keeps OpenClaw integration small and explicit:

- OpenClaw tool call
- Loopback bridge (`127.0.0.1`)
- ComfyUI prompt queue + image result

## Enable the plugin

1. Enable `comfyui`:

```json
{
  "plugins": {
    "entries": {
      "comfyui": {
        "enabled": true
      }
    }
  }
}
```

2. Allowlist the tool (it is registered with `optional: true`):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": ["comfy_generate"]
        }
      }
    ]
  }
}
```

## Plugin config

Set config under `plugins.entries.comfyui.config`:

```json
{
  "plugins": {
    "entries": {
      "comfyui": {
        "enabled": true,
        "config": {
          "bridgeUrl": "http://127.0.0.1:8787",
          "timeoutMs": 180000,
          "defaultModel": "flux.1-dev",
          "allowedModels": ["flux.1-dev"],
          "allowedPathRoots": ["/home/user/comfy-assets", "/tmp"],
          "outputDir": "/home/user/.local/share/comfyui/output"
        }
      }
    }
  }
}
```

Important:

- `bridgeUrl` must be loopback (`localhost` / `127.0.0.1` / `::1`).
- If `allowedModels` is set, model overrides outside that list are rejected.
- Input/workflow files must be absolute and inside `allowedPathRoots`.

## Bridge startup

Run the bundled bridge script on the same host as ComfyUI:

```bash
python3 extensions/comfyui/scripts/comfy_bridge.py
```

Useful environment variables:

- `COMFYUI_URL` (default: `http://127.0.0.1:8188`)
- `COMFY_BRIDGE_HOST` (default: `127.0.0.1`)
- `COMFY_BRIDGE_PORT` (default: `8787`)
- `COMFY_ALLOWED_ROOTS` (`:`-separated absolute roots)
- `COMFY_BRIDGE_OUTPUT_DIR` (where bridge writes generated images)

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Tool parameters

- `mode`: `txt2img` | `img2img` (default: `txt2img`)
- `prompt` (required)
- `negativePrompt` (optional)
- `width`, `height`, `steps`, `guidance`, `seed`
- `model` (optional)
- `initImagePath` (required for `img2img`)
- `denoise` (optional)
- `control` (optional array)
- `ipAdapter` (optional object)
- `loras` (optional array)
- `workflowPath` (optional absolute JSON path)
- `timeoutMs` (optional override)

## Control stack behavior

For `control`, `ipAdapter`, or `loras`, `workflowPath` is required.

The bridge supports placeholder substitution in workflow JSON. Supported
placeholders include:

- `$OPENCLAW_PROMPT`, `$OPENCLAW_NEGATIVE_PROMPT`
- `$OPENCLAW_WIDTH`, `$OPENCLAW_HEIGHT`
- `$OPENCLAW_STEPS`, `$OPENCLAW_GUIDANCE`, `$OPENCLAW_SEED`, `$OPENCLAW_DENOISE`
- `$OPENCLAW_MODEL`, `$OPENCLAW_INIT_IMAGE`
- `$OPENCLAW_IPADAPTER_IMAGE`, `$OPENCLAW_IPADAPTER_WEIGHT`
- `$OPENCLAW_CONTROL_1_IMAGE`, `$OPENCLAW_CONTROL_1_TYPE`, etc.
- `$OPENCLAW_LORA_1_NAME`, `$OPENCLAW_LORA_1_SCALE`, etc.

If placeholders remain unresolved, the bridge returns a clear error.

## Output

On success, the tool returns:

- `MEDIA:<absolute_path>` for generated image delivery
- a short metadata text (mode/size/seed/model)

## Safety notes

- Bridge and tool enforce loopback-only integration.
- The bridge writes a local output file and returns that path.
- Missing files/models/nodes fail fast with explicit error payloads.
- Keep side-effecting actions separate from generation approval decisions.
