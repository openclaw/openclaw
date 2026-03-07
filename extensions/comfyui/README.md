# ComfyUI (plugin)

Adds an optional `comfy_generate` tool for local image generation through a
loopback bridge (`scripts/comfy_bridge.py`).

## Enable

```json
{
  "plugins": {
    "entries": {
      "comfyui": {
        "enabled": true
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["comfy_generate"] }
      }
    ]
  }
}
```

## Plugin config

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
          "allowedPathRoots": ["/home/user/comfy-assets", "/tmp"]
        }
      }
    }
  }
}
```

## Bridge startup

```bash
cd /path/to/openclaw/extensions/comfyui/scripts
python3 comfy_bridge.py
```

The bridge talks to ComfyUI at `COMFYUI_URL` (default
`http://127.0.0.1:8188`) and serves on `127.0.0.1:8787`.
