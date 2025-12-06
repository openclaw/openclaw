# Web Chat (macOS menu bar)

The macOS Clawdis app ships a built-in web chat window that reuses your primary Clawd session instead of creating a new one. This is meant for quick desktop access without exposing any local HTTP ports.

## How it works

- UI: `pi-mono/packages/web-ui` bundle loaded in a `WKWebView`.
- Bridge: `WKScriptMessageHandler` named `clawdis` (see `apps/macos/Sources/Clawdis/WebChatWindow.swift`). The page posts `sessionKey` + message; Swift shells `pnpm clawdis agent --to <sessionKey> --message <text> --json` and returns the first payload text to the page. No sockets are opened.
- Session selection: picks the most recently updated entry in `~/.clawdis/sessions/sessions.json`; falls back to `+1003` if none exist. This keeps the web chat on the same primary conversation as the relay/CLI.
- Assets: currently loads `pi-web-ui` directly from `../pi-mono/packages/web-ui/dist` on disk. (We should copy it into the app bundle in a future step.)

## Requirements

- `pnpm` on PATH.
- `pnpm install` already run in the repo so `pnpm clawdis agent ...` works.
- `pi-mono` checked out at `../pi-mono` with `packages/web-ui/dist` built.

## Limitations / TODO

- Single-turn (no streaming), text-only; attachments/tools not wired yet.
- Absolute dist path; bundle should be copied into app resources and versioned.
- Errors from the agent subprocess are minimally surfaced.

## Usage

- Launch the macOS Clawdis menu bar app, click the lobster icon → “Open Web Chat”.
- Type and send; replies continue the primary Clawd session.
