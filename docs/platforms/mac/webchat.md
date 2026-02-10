---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How the mac app embeds the gateway WebChat and how to debug it"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging mac WebChat view or loopback port（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "WebChat"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# WebChat (macOS app)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS menu bar app embeds the WebChat UI as a native SwiftUI view. It（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
connects to the Gateway and defaults to the **main session** for the selected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent (with a session switcher for other sessions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local mode**: connects directly to the local Gateway WebSocket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote mode**: forwards the Gateway control port over SSH and uses that（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tunnel as the data plane.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Launch & debugging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Manual: Lobster menu → “Open Chat”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto‑open for testing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logs: `./scripts/clawlog.sh` (subsystem `bot.molt`, category `WebChatSwiftUI`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it’s wired（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Data plane: Gateway WS methods `chat.history`, `chat.send`, `chat.abort`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `chat.inject` and events `chat`, `agent`, `presence`, `tick`, `health`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session: defaults to the primary session (`main`, or `global` when scope is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  global). The UI can switch between sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding uses a dedicated session to keep first‑run setup separate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security surface（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote mode forwards only the Gateway WebSocket control port over SSH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Known limitations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The UI is optimized for chat sessions (not a full browser sandbox).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
