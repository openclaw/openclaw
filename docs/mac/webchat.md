---
summary: "How the mac app embeds the gateway WebChat and how to debug it"
read_when:
  - Debugging mac WebChat view or loopback port
---
# Web Chat (macOS app)

The macOS menu bar app opens the gateway’s loopback web chat server in a WKWebView. It reuses the **primary Clawd session** (`main` by default, configurable via `inbound.reply.session.mainKey`). The server is started by the Node gateway (default port 18788, see `webchat.port`).

## Launch & debugging
- Manual: Lobster menu → “Open Chat”.
- Auto-open for testing: run `dist/Clawdis.app/Contents/MacOS/Clawdis --webchat` (or pass `--webchat` to the binary launched by launchd). The window opens on startup.
- Inspect: right-click the web view → “Inspect Element” (developerExtras enabled). Console logs go to the Swift logger (subsystem `com.steipete.clawdis`, category `WebChat`). The HTML boot script also writes status text into the `#app` div until the panel mounts.
- WK logs: navigation lifecycle, readyState, js location, and JS errors/unhandled rejections are mirrored to OSLog for easier diagnosis.

## How it’s wired
- Assets: `apps/macos/Sources/Clawdis/Resources/WebChat/` contains the `pi-web-ui` dist plus a local import map pointing at bundled vendor modules and a tiny `pi-ai` stub. Everything is served from the static host at `/` (legacy `/webchat/*` still works).
- Bridge: none. The web UI connects directly to the Gateway WebSocket (default 18789) and uses `chat.history`/`chat.send` plus `chat/presence/tick/health` events. No `/rpc` or file-watcher socket path remains.
- Session: always primary; multiple transports (WhatsApp/Telegram/Desktop) share the same session key so context is unified.
- Debug-only: a native SwiftUI “glass” chat UI (same WS transport, attachments + thinking selector) can replace the WKWebView. Enable it via Debug → “Use SwiftUI web chat (glass, gateway WS)” (default off).

## Security / surface area
- Loopback server only; remote mode uses SSH port-forwarding from the gateway host to the Mac. CSP is set to `default-src 'self' 'unsafe-inline' data: blob:`.
- Web Inspector is opt-in via right-click; otherwise WKWebView stays in the app sandbox.

## Known limitations
- Text-only, single-turn (no streaming); tools/attachments not yet plumbed.
- Uses a stubbed pi-ai for model metadata; model selection is fixed to the primary Clawd backend.

## Updating the bundle
1) Ensure `../pi-mono` is present and built (`pnpm install` + `pnpm build` inside `packages/web-ui`).
2) Copy vendor deps into `Resources/WebChat/vendor` (currently synced from `../pi-mono/node_modules`).
3) Rebuild/restart the mac app with `./scripts/restart-mac.sh` so the new assets land in the bundle.
