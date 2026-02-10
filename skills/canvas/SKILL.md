# Canvas Skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Display HTML content on connected OpenClaw nodes (Mac app, iOS, Android).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The canvas tool lets you present web content on any connected node's canvas view. Great for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Displaying games, visualizations, dashboards（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Showing generated HTML content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Interactive demos（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How It Works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  Canvas Host    │────▶│   Node Bridge    │────▶│  Node App   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  (HTTP Server)  │     │  (TCP Server)    │     │ (Mac/iOS/   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  Port 18793     │     │  Port 18790      │     │  Android)   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└─────────────────┘     └──────────────────┘     └─────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Canvas Host Server**: Serves static HTML/CSS/JS files from `canvasHost.root` directory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Node Bridge**: Communicates canvas URLs to connected nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Node Apps**: Render the content in a WebView（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tailscale Integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The canvas host server binds based on `gateway.bind` setting:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Bind Mode  | Server Binds To     | Canvas URL Uses            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------------------- | -------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `loopback` | 127.0.0.1           | localhost (local only)     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `lan`      | LAN interface       | LAN IP address             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `tailnet`  | Tailscale interface | Tailscale hostname         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `auto`     | Best available      | Tailscale > LAN > loopback |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key insight:** The `canvasHostHostForBridge` is derived from `bridgeHost`. When bound to Tailscale, nodes receive URLs like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
http://<tailscale-hostname>:18793/__openclaw__/canvas/<file>.html（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is why localhost URLs don't work - the node receives the Tailscale hostname from the bridge!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Action     | Description                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `present`  | Show canvas with optional target URL |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hide`     | Hide the canvas                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `navigate` | Navigate to a new URL                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `eval`     | Execute JavaScript in the canvas     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `snapshot` | Capture screenshot of canvas         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "canvasHost": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "port": 18793,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "root": "/Users/you/clawd/canvas",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "liveReload": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "gateway": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "bind": "auto"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Live Reload（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `liveReload: true` (default), the canvas host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Watches the root directory for changes (via chokidar)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Injects a WebSocket client into HTML files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Automatically reloads connected canvases when files change（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Great for development!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1. Create HTML content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Place files in the canvas root directory (default `~/clawd/canvas/`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat > ~/clawd/canvas/my-game.html << 'HTML'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<!DOCTYPE html>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<html>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<head><title>My Game</title></head>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<body>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <h1>Hello Canvas!</h1>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</body>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</html>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
HTML（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2. Find your canvas host URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check how your gateway is bound:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat ~/.openclaw/openclaw.json | jq '.gateway.bind'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then construct the URL:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **loopback**: `http://127.0.0.1:18793/__openclaw__/canvas/<file>.html`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **lan/tailnet/auto**: `http://<hostname>:18793/__openclaw__/canvas/<file>.html`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Find your Tailscale hostname:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3. Find connected nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for Mac/iOS/Android nodes with canvas capability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4. Present content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
canvas action:present node:<node-id> target:<full-url>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
canvas action:present node:mac-63599bc4-b54d-4392-9048-b97abd58343a target:http://peters-mac-studio-1.sheep-coho.ts.net:18793/__openclaw__/canvas/snake.html（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5. Navigate, snapshot, or hide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
canvas action:navigate node:<node-id> url:<new-url>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
canvas action:snapshot node:<node-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
canvas action:hide node:<node-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debugging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### White screen / content not loading（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Cause:** URL mismatch between server bind and node expectation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Debug steps:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Check server bind: `cat ~/.openclaw/openclaw.json | jq '.gateway.bind'`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Check what port canvas is on: `lsof -i :18793`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Test URL directly: `curl http://<hostname>:18793/__openclaw__/canvas/<file>.html`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Solution:** Use the full hostname matching your bind mode, not localhost.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### "node required" error（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Always specify `node:<node-id>` parameter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### "node not connected" error（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Node is offline. Use `openclaw nodes list` to find online nodes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Content not updating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If live reload isn't working:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Check `liveReload: true` in config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Ensure file is in the canvas root directory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Check for watcher errors in logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## URL Path Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The canvas host serves from `/__openclaw__/canvas/` prefix:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
http://<host>:18793/__openclaw__/canvas/index.html  → ~/clawd/canvas/index.html（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
http://<host>:18793/__openclaw__/canvas/games/snake.html → ~/clawd/canvas/games/snake.html（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `/__openclaw__/canvas/` prefix is defined by `CANVAS_HOST_PATH` constant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep HTML self-contained (inline CSS/JS) for best results（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use the default index.html as a test page (has bridge diagnostics)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The canvas persists until you `hide` it or navigate away（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Live reload makes development fast - just save and it updates!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A2UI JSON push is WIP - use HTML files for now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
