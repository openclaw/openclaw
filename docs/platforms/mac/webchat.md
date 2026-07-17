---
summary: "How the mac app embeds the gateway WebChat and how to debug it"
read_when:
  - Debugging mac WebChat view or loopback port
title: "WebChat (macOS)"
---

The macOS menu bar app embeds the WebChat UI as a native SwiftUI view. It connects to the Gateway and defaults to the primary session for the selected agent (`main`, or `global` when `session.scope` is `global`).

The full chat window is a native split view:

- **Sessions sidebar**: searchable session list with pinned and recent sections, unread indicators, and context menus for pin/unpin, copy session key, and delete. A toolbar button (or Cmd-N) creates a real new session via `sessions.create`.
- **Window toolbar**: context-usage ring (tokens and session cost, with a compact action), thinking-level picker, model picker, and a session actions menu. **Sessions…** (Shift-Cmd-S) opens the Active/Archived manager for gateway search, rename, pin, archive, and restore. The same menu can show or hide assistant reasoning and tool activity; this is on by default and remembered across launches.
- **Transcript and composer**: assistant messages render as plain text with an avatar, user messages as accent bubbles. Empty chats offer desktop starter prompts. Typing `/` opens slash-command autocomplete backed by `commands.list`, with arrow/Tab/Return/Escape keyboard navigation. Right-click a message to copy it, or use **Listen** for gateway TTS with a local speech fallback.
- **Voice controls**: the composer can start or stop the existing macOS Talk Mode without replacing its menu-bar overlay. A separate microphone action records a voice note when Talk Mode does not own audio capture.

The anchored compact chat panel from the menu bar keeps the compact single-column layout with inline pickers, starter prompts, Talk Mode, voice notes, and Listen. Assistant reasoning and tool activity remain hidden in this compact surface.

## Quick Chat bar

Press Option-Space (⌥Space) or choose **Quick Chat** from the menu bar menu to open a floating composer for the main session. Change the global shortcut with the recorder in **Settings → General → Quick Chat shortcut**.

Quick Chat shows the main session's agent, sends directly to the main session, and leaves replies in the full chat window. Press Return to send, Command-Return to send and open full chat, Shift-Return for a newline, or Escape to dismiss. Clicking outside the bar also dismisses it. When relevant macOS permissions are missing, an attached strip offers **Grant** and **Not now** actions.

- **Local mode**: connects directly to the local Gateway WebSocket.
- **Remote mode**: forwards the Gateway control port over SSH and uses that tunnel as the data plane.

## Launch and debugging

- Manual: Lobster menu -> "Open Chat".
- Auto-open for testing:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --chat
  ```

  (`--webchat` is accepted as a legacy alias.)

- Logs: `./scripts/clawlog.sh` (subsystem `ai.openclaw`, category `WebChatSwiftUI`).

## How it is wired

- Data plane: Gateway WS methods `chat.history`, `chat.send`, `chat.abort`, `chat.inject`, and events `chat`, `agent`, `presence`, `tick`, `health`.
- `chat.history` returns a display-normalized transcript: inline directive tags are stripped from visible text, plain-text tool-call XML payloads (`<tool_call>`, `<function_call>`, `<tool_calls>`, `<function_calls>`, including truncated blocks) and leaked model control tokens are stripped, pure silent-token assistant rows such as exact `NO_REPLY`/`no_reply` are omitted, and oversized rows can be replaced with a truncated placeholder.
- Session: defaults to the primary session as above; the UI can switch between sessions.
- Onboarding uses a dedicated session to keep first-run setup separate.
- Offline cache: the app keeps a small read-only cache of recent chat sessions and transcripts per gateway (`~/Library/Application Support/OpenClaw/chat-cache.sqlite`): cold opens paint the last known transcript immediately and refresh once the Gateway responds, and recent chats stay browsable while disconnected (sending stays disabled until the connection is back).

## Security surface

- Remote mode forwards only the Gateway WebSocket control port over SSH.

## Known limitations

- The UI is optimized for chat sessions, not a full browser sandbox.

## Related

- [WebChat](/web/webchat)
- [macOS app](/platforms/macos)
