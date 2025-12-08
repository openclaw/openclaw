# Web Chat (macOS app)

The macOS menu bar app opens the relay’s loopback web chat server in a WKWebView. It reuses the **primary Clawd session** (`main` by default, configurable via `inbound.reply.session.mainKey`). The server is started by the Node relay (default port 18788, see `webchat.port`).

## Launch & debugging
- Manual: Lobster menu → “Open Chat”.
- Auto-open for testing: run `dist/Clawdis.app/Contents/MacOS/Clawdis --webchat` (or pass `--webchat` to the binary launched by launchd). The window opens on startup.
- Inspect: right-click the web view → “Inspect Element” (developerExtras enabled). Console logs go to the Swift logger (subsystem `com.steipete.clawdis`, category `WebChat`). The HTML boot script also writes status text into the `#app` div until the panel mounts.
- WK logs: navigation lifecycle, readyState, js location, and JS errors/unhandled rejections are mirrored to OSLog for easier diagnosis.

## How it’s wired
- Assets: `apps/macos/Sources/Clawdis/Resources/WebChat/` contains the `pi-web-ui` dist plus a local import map pointing at bundled vendor modules and a tiny `pi-ai` stub. Everything is served from the relay at `/webchat/*`.
- Bridge: none. The web UI calls `/webchat/rpc` directly; Swift no longer proxies messages. RPC is handled in-process inside the relay (no CLI spawn/PATH dependency).
- Session: always primary; multiple transports (WhatsApp/Telegram/Desktop) share the same session key so context is unified.

## Security / surface area
- Loopback server only; remote mode uses SSH port-forwarding from the relay host to the Mac. CSP is set to `default-src 'self' 'unsafe-inline' data: blob:`.
- Web Inspector is opt-in via right-click; otherwise WKWebView stays in the app sandbox.

## Known limitations
- Text-only, single-turn (no streaming); tools/attachments not yet plumbed.
- Uses a stubbed pi-ai for model metadata; model selection is fixed to the primary Clawd backend.

## Updating the bundle
1) Ensure `../pi-mono` is present and built (`pnpm install` + `pnpm build` inside `packages/web-ui`).
2) Copy vendor deps into `Resources/WebChat/vendor` (currently synced from `../pi-mono/node_modules`).
3) Rebuild/restart the mac app with `./scripts/restart-mac.sh` so the new assets land in the bundle.
