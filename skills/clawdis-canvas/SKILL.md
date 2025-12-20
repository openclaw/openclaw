---
name: clawdis-canvas
description: Drive the Clawdis Canvas panel (present, eval, snapshot, A2UI) via the clawdis CLI, including gateway-hosted A2UI surfaces and action bridging.
metadata: {"clawdis":{"emoji":"🎨","always":true}}
---

# Clawdis Canvas

Use Canvas to render HTML/JS or A2UI surfaces and capture snapshots.

Core commands
- Present: `clawdis canvas present [--node <id>] [--target <path>]`
- Hide: `clawdis canvas hide`
- Eval JS: `clawdis canvas eval --js "..."`
- Snapshot: `clawdis canvas snapshot`

A2UI
- Push JSONL: `clawdis canvas a2ui push --jsonl /path/to/file.jsonl`
- Reset: `clawdis canvas a2ui reset`

Notes
- Keep HTML under `~/clawd/canvas` when targeting remote nodes.
- Use snapshot after renders to verify UI state.
- Treat A2UI as gateway-hosted at `http(s)://<gateway-host>:18789/__clawdis__/a2ui/`.
- Rely on `canvas a2ui push/reset` to auto-navigate the Canvas to the gateway-hosted A2UI page.
- Expect A2UI to fail if the Gateway does not advertise `canvasHostUrl` or is unreachable:
  - `A2UI_HOST_NOT_CONFIGURED`
  - `A2UI_HOST_UNAVAILABLE`

A2UI quick flow
1. Ensure the Gateway is running and reachable from the node.
2. Build JSONL with **v0.8** server→client messages (`beginRendering`, `surfaceUpdate`, `dataModelUpdate`, `deleteSurface`).
   - Do not use v0.9 `createSurface` (unsupported).
3. Push JSONL and (optionally) snapshot the result.

Example JSONL (v0.8)
```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOF'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"A2UI (v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI is live."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOF

clawdis canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Action callbacks (A2UI → agent)
- A2UI user actions (buttons, etc.) are bridged from the WebView back to the node via `clawdisCanvasA2UIAction`.
- Handle them on the agent side as `CANVAS_A2UI` messages (node → gateway → agent).
