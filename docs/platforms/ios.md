---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "iOS node app: connect to the Gateway, pairing, canvas, and troubleshooting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Pairing or reconnecting the iOS node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running the iOS app from source（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging gateway discovery or canvas commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "iOS App"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# iOS App (Node)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Availability: internal preview. The iOS app is not publicly distributed yet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connects to a Gateway over WebSocket (LAN or tailnet).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exposes node capabilities: Canvas, Screen snapshot, Camera capture, Location, Talk mode, Voice wake.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Receives `node.invoke` commands and reports node status events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway running on another device (macOS, Linux, or Windows via WSL2).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Network path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Same LAN via Bonjour, **or**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Tailnet via unicast DNS-SD (example domain: `openclaw.internal.`), **or**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Manual host/port (fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start (pair + connect)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Start the Gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. In the iOS app, open Settings and pick a discovered gateway (or enable Manual Host and enter host/port).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Approve the pairing request on the gateway host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Verify connection:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway call node.list --params "{}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Discovery paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bonjour (LAN)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway advertises `_openclaw-gw._tcp` on `local.`. The iOS app lists these automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tailnet (cross-network)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If mDNS is blocked, use a unicast DNS-SD zone (choose a domain; example: `openclaw.internal.`) and Tailscale split DNS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Bonjour](/gateway/bonjour) for the CoreDNS example.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manual host/port（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In Settings, enable **Manual Host** and enter the gateway host + port (default `18789`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Canvas + A2UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The iOS node renders a WKWebView canvas. Use `node.invoke` to drive it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Gateway canvas host serves `/__openclaw__/canvas/` and `/__openclaw__/a2ui/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The iOS node auto-navigates to A2UI on connect when a canvas host URL is advertised.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Return to the built-in scaffold with `canvas.navigate` and `{"url":""}`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Canvas eval / snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Voice wake + talk mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice wake and talk mode are available in Settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS may suspend background audio; treat voice features as best-effort when the app is not active.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `NODE_BACKGROUND_UNAVAILABLE`: bring the iOS app to the foreground (canvas/camera/screen commands require it).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `A2UI_HOST_NOT_CONFIGURED`: the Gateway did not advertise a canvas host URL; check `canvasHost` in [Gateway configuration](/gateway/configuration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing prompt never appears: run `openclaw nodes pending` and approve manually.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reconnect fails after reinstall: the Keychain pairing token was cleared; re-pair the node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Pairing](/gateway/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Discovery](/gateway/discovery)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Bonjour](/gateway/bonjour)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
