---
summary: "How the mac app embeds the gateway WebChat and how to debug it"
read_when:
  - Debugging mac WebChat view or loopback port
---
# Web Chat (macOS app)

The macOS menu bar app shows the WebChat UI as a native SwiftUI view and reuses the **primary Clawd session** (`main`, or `global` when scope is global).

- **Local mode**: connects directly to the local Gateway WebSocket.
- **Remote mode**: forwards the Gateway WebSocket control port over SSH and uses that as the data plane.

## Launch & debugging
- Manual: Lobster menu → “Open Chat”.
- Auto-open for testing: run `dist/Clawdbot.app/Contents/MacOS/Clawdbot --webchat` (or pass `--webchat` to the binary launched by launchd). The window opens on startup.
- Logs: see [`./scripts/clawlog.sh`](https://github.com/clawdbot/clawdbot/blob/main/scripts/clawlog.sh) (subsystem `com.clawdbot`, category `WebChatSwiftUI`).

## How it’s wired
- Implementation: [`apps/macos/Sources/Clawdbot/WebChatSwiftUI.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/Clawdbot/WebChatSwiftUI.swift) hosts `ClawdbotChatUI` and speaks to the Gateway over `GatewayConnection`.
- Data plane: Gateway WebSocket methods `chat.history`, `chat.send`, `chat.abort`; events `chat`, `agent`, `presence`, `tick`, `health`.
- Session: usually primary (`main`); multiple transports (WhatsApp/Telegram/Discord/Desktop) share the same key. The onboarding flow uses a dedicated `onboarding` session to keep first-run setup separate.

## Security / surface area
- Remote mode forwards only the Gateway WebSocket control port over SSH.

## Known limitations
- The UI is optimized for the primary session and typical “chat” usage (not a full browser-based sandbox surface).
