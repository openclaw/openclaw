---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Agent-controlled Canvas panel embedded via WKWebView + custom URL scheme"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing the macOS Canvas panel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding agent controls for visual workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging WKWebView canvas loads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Canvas"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Canvas (macOS app)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app embeds an agent‑controlled **Canvas panel** using `WKWebView`. It（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is a lightweight visual workspace for HTML/CSS/JS, A2UI, and small interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UI surfaces.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where Canvas lives（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Canvas state is stored under Application Support:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/Library/Application Support/OpenClaw/canvas/<session>/...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Canvas panel serves those files via a **custom URL scheme**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw-canvas://<session>/<path>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no `index.html` exists at the root, the app shows a **built‑in scaffold page**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Panel behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Borderless, resizable panel anchored near the menu bar (or mouse cursor).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remembers size/position per session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto‑reloads when local canvas files change.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only one Canvas panel is visible at a time (session is switched as needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Canvas can be disabled from Settings → **Allow Canvas**. When disabled, canvas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node commands return `CANVAS_DISABLED`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent API surface（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Canvas is exposed via the **Gateway WebSocket**, so the agent can:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- show/hide the panel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- navigate to a path or URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- evaluate JavaScript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- capture a snapshot image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas present --node <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas navigate --node <id> --url "/"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas eval --node <id> --js "document.title"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas snapshot --node <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvas.navigate` accepts **local canvas paths**, `http(s)` URLs, and `file://` URLs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you pass `"/"`, the Canvas shows the local scaffold or `index.html`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## A2UI in Canvas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A2UI is hosted by the Gateway canvas host and rendered inside the Canvas panel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the Gateway advertises a Canvas host, the macOS app auto‑navigates to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A2UI host page on first open.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default A2UI host URL:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
http://<gateway-host>:18793/__openclaw__/a2ui/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### A2UI commands (v0.8)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Canvas currently accepts **A2UI v0.8** server→client messages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `beginRendering`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `surfaceUpdate`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dataModelUpdate`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deleteSurface`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`createSurface` (v0.9) is not supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"beginRendering":{"surfaceId":"main","root":"root"}}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
EOFA2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick smoke:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Triggering agent runs from Canvas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Canvas can trigger new agent runs via deep links:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw://agent?...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (in JS):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```js（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
window.location.href = "openclaw://agent?message=Review%20this%20design";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The app prompts for confirmation unless a valid key is provided.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Canvas scheme blocks directory traversal; files must live under the session root.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local Canvas content uses a custom scheme (no loopback server required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- External `http(s)` URLs are allowed only when explicitly navigated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
