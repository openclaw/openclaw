# Canvas / A2UI

## Goal
- A2UI rendering works out-of-the-box (no per-user toggles).
- A2UI button clicks always reach the agent automatically.
- Canvas chrome (close button) stays readable on any content.

## Current behavior
- Canvas can show a bundled A2UI shell at `/__clawdis__/a2ui/` when no session `index.html` exists.
- The A2UI shell forwards `a2ui.action` button clicks to native via `WKScriptMessageHandler` (`clawdisCanvasA2UIAction`).
- Native forwards the click to the gateway as an agent invocation.

## Fixes (2025-12-17)
- Close button: render a small vibrancy/material pill behind the “x” and reduce the button size for less visual weight.
- Click reliability:
  - Allow A2UI clicks from any local Canvas path (not just `/` or the built-in A2UI shell).
  - Inject an A2UI → native bridge at document start that listens for `a2uiaction` and forwards it:
    - Prefer `WKScriptMessageHandler` when available.
    - Otherwise fall back to an unattended `clawdis://agent?...&key=...` deep link (no prompt).
  - Avoid double-sending actions when the bundled A2UI shell is present (let the shell forward clicks so it can resolve richer context).
  - Intercept `clawdis://…` navigations inside the Canvas WKWebView and route them through `DeepLinkHandler` (no NSWorkspace bounce).
  - `GatewayConnection` auto-starts the local gateway (and retries briefly) when a request fails in `.local` mode, so Canvas actions don’t silently fail if the gateway isn’t running yet.
  - Fix a crash that made `clawdis-mac canvas show`/`eval` look “hung”:
    - `VoicePushToTalkHotkey`’s NSEvent monitor could call `@MainActor` code off-main, triggering executor checks / EXC_BAD_ACCESS on macOS 26.2.
    - Now it hops back to the main actor before mutating state.
  - Preserve in-page state when closing Canvas (hide the window instead of closing the `WKWebView`).
  - Fix another “Canvas looks hung” source: node pairing approval used `NSAlert.runModal()` on the main actor, which stalls Canvas/IPC while the alert is open.
  - Add UX feedback + better agent prompting:
    - Show a small “Sending/Working” spinner when a button is clicked.
    - Show “Updated/Failed” toasts (failures include the gateway error string).
    - Send a compact, unambiguous agent message that includes machine identity + Canvas context (instead of a big JSON markdown block).
    - Native acks the click back into the page via `clawdis:a2ui-action-status` so the UI can switch from “Sending…” to “Working…” immediately.

## Suggested message format (token-efficient)
We want the model to immediately understand:
- This is a **Canvas UI event** (not user chat).
- It happened on **this specific Mac**.
- Default behavior is to **update the Canvas UI** (unless the button context says otherwise).

Proposed message line (single-line, parseable):

```
CANVAS_A2UI action=<name> session=<sessionKey> surface=<surfaceId> component=<componentId> host=<machine> instance=<instanceId> ctx=<json?> default=update_canvas
```

## Follow-ups
- Add a small “action sent / failed” debug overlay in the A2UI shell (dev-only) to make failures obvious.
- Decide whether non-local Canvas content should ever be allowed to emit A2UI actions (current stance: no, for safety).
