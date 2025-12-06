# Web Chat (macOS menu bar)

The macOS Clawdis app ships a built-in web chat window that reuses your primary Clawd session instead of creating a new one. This is meant for quick desktop access without exposing any local HTTP ports.

## How it works

- UI: `pi-mono/packages/web-ui` bundle loaded in a `WKWebView`.
- Bridge: `WKScriptMessageHandler` named `clawdis` (see `apps/macos/Sources/Clawdis/WebChatWindow.swift`). The page posts `sessionKey` + message; Swift shells `pnpm clawdis agent --to <sessionKey> --message <text> --json` and returns the first payload text to the page. No sockets are opened.
- Session selection: always uses the canonical `main` session key (or `inbound.reply.session.mainKey`), hydrating from the Tau JSONL session file so you see the full history even when messages arrived via WhatsApp/Telegram.
- Assets: the entire `pi-web-ui` dist plus dependencies (pi-ai, mini-lit, lit, lucide, pdfjs-dist, docx-preview, jszip) is bundled into `apps/macos/Sources/Clawdis/Resources/WebChat/` and shipped with the app. No external checkout is required at runtime.

## Requirements

- `pnpm` on PATH.
- `pnpm install` already run in the repo so `pnpm clawdis agent ...` works.
- `pi-mono` checked out at `../pi-mono` with `packages/web-ui/dist` built.

## Limitations / TODO

- Single-turn (no streaming), text-only; attachments/tools not wired yet.
- Absolute dist path; bundle should be copied into app resources and versioned.
- Errors from the agent subprocess are minimally surfaced.

## Usage

- Launch the macOS Clawdis menu bar app, click the lobster icon → “Open Chat”.
- Type and send; replies continue the primary Clawd session.
