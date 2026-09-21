---
summary: "Choose the Web or experimental Native Mac experience and use Gateway chat windows"
read_when:
  - Choosing the Web or Native Mac experience
  - Debugging mac WebChat view or loopback port
  - Choosing colors for native chat sessions
title: "WebChat (macOS)"
---

The macOS app uses the **Web** experience by default, embedding the Gateway's
[Control UI](/web/control-ui) in an app window. To use native SwiftUI chat,
open **Dashboard → Settings → This Mac → App** and enable **Native experience
(Experimental)**. Turn it off to return to Web.

This preference applies to **Open Dashboard**, **New Gateway Window…**, Gateway
menus, full chat opens, and dashboard launch links. Switching experiences hides
the previous experience's windows, keeps their loaded drafts, and cancels
pending window opens. If a window was visible, the same Gateway opens in the
selected experience. **Settings…** always opens web Dashboard settings;
**Connection…** and **About OpenClaw** open the native Connection window; About selects its **About** tab.

Gateway and account changes still refresh hidden Dashboard windows. Saved web
drafts recover within the same Gateway address and authenticated account; they
are not copied to a different Gateway, account, or recreated SSH tunnel address.

The native chat features below connect to the Gateway and default to the primary
session for the selected agent (`main`, or `global` when `session.scope` is
`global`). Quick Chat remains a native floating composer in either experience.

The full native chat window is a split view:

- **Agents and threads sidebar**: named agents appear above the searchable thread list, with their configured emoji or initial, a quiet selection highlight, and activity and unread summaries from loaded sessions. Selecting an agent opens its primary conversation and names the thread section for that agent; switching back restores that conversation's text draft. Pinned threads, gateway-backed groups, and recent threads keep their existing sections. Thread rows show timestamps and recent visible text from the local transcript cache when available; current activity and attention messages take precedence over previews. Spawned child sessions nest beneath their parent inside each section; collapsed parents summarize running, failed, and unread descendants. Context menus support session info, rename, pin, fork, read/unread, archive/restore, copy session key, and delete. **New Thread** (Shift-Cmd-N) creates immediately for the selected agent via `sessions.create`; its adjacent options popover starts with the selected agent and offers **Separate working copy** to create a managed Git worktree with an optional base branch or commit.
- **Window toolbar**: a plain conversation title and active agent, a labeled working, queued, or attention state when known, Find in Conversation, and a session actions menu. Pending questions and current model authentication failures also surface attention; answered or expired questions do not. The menu can rename or fork the current session and update its pin, read, or archive state. **Threads…** (Shift-Cmd-S) opens the Active/Archived manager for gateway search, group management, session inspection, rename, pin, archive, and restore. Select mode applies pin, unpin, archive, or delete to several active sessions while keeping individual failures visible. Separate menu checkmarks show or hide assistant reasoning and tool activity; both are on by default and remembered across launches.
- **Transcript and composer**: a centered reading column keeps messages and the composer aligned in wide windows. Assistant messages render as plain text without repeated avatars, user messages as muted accent bubbles. Dark mode uses softer gray text on charcoal while retaining enhanced text contrast; Increase Contrast raises text contrast further. The rounded composer names the selected agent, starts at a compact single-line height, grows with multiline drafts, and keeps attachment, model, voice, and send controls aligned beneath the text. The **+** menu contains attachments, branches, and tool-call verbosity. The context ring shows token usage and session cost and offers **Compact Thread**. The model menu groups models by provider, keeps pinned and recent models at the top, and lets you pin or unpin the selected model. **Model sign-in** lives in this menu and remains available when no models are listed. When the selected model cannot send because its credentials are missing or invalid, an inline notice beside the composer offers **Model sign-in** and **Retry**. Temporary cooldowns do not show this authentication notice. **Effort** contains thinking and Fast response settings. Controls adapt to narrow windows while keeping voice and send actions visible. Return sends; Shift-Return inserts a newline. Copy, Reply, Listen, and a message actions menu appear beneath messages on hover or keyboard focus; right-click actions remain available. Tool activity uses compact cards with explicit working, finished, failed, or no-result labels; expand a card to read its result or diff. Subagent cards lead with the child task's display title, using its configured `label` when present, with queued, working, finished, failed, or cancelled status shown separately. Tasks without a display title keep the generic **Subagent** label. Expand a card to read its activity details. Pending agent questions render as native cards with single- or multi-select options, free-text **Other** answers, expiry countdowns, and shared terminal state. Empty chats offer desktop starter prompts. Typing `/` opens slash-command autocomplete backed by `commands.list`, with arrow/Tab/Return/Escape keyboard navigation. Right-click a message to copy its visible Markdown without hidden reasoning. Truncated assistant messages also offer **Open Full Message**, which loads a selectable Markdown reader. Use **Listen** for gateway TTS with a local speech fallback.
- **Find in Conversation**: press Cmd-F to search user and assistant text in the loaded conversation. Return or Cmd-G moves to the next matching message; Shift-Cmd-G moves backward. The selected message is outlined and revealed without incoming replies pulling you away. Escape closes Find. Search does not fetch older history or search hidden reasoning and tool payloads.
- **Voice controls**: the composer can start or stop the existing macOS Talk Mode without replacing its menu-bar overlay. While Talk Mode is active, the composer shows its listening/thinking/speaking state, live audio activity, and an expandable rolling transcript. Right-click the Talk button to choose **System Default** or a connected microphone; this is the same microphone selection used by Voice Wake and push-to-talk. If a selected microphone disconnects, the active Talk session falls back to the system default and tries the selection again the next time Talk Mode starts. A separate microphone action records a voice note when Talk Mode does not own audio capture.

The anchored compact chat panel from the menu bar keeps the compact single-column layout with the same model, thinking, verbosity, and Fast controls inline, plus starter prompts, Talk Mode, voice notes, and Listen. Assistant reasoning and tool activity remain hidden in this compact surface.

In the full macOS chat window, completed commentary, reasoning, and tool work
collapse into a **Worked for…** disclosure above the answer. Expand it to inspect
the work; final text, images, and other attachments stay visible. Active turns,
work without a final answer, and unresolved or failed work after the answer remain
expanded. Work stays on its own side of forwarded messages, new inputs, and
history dividers. Find in Conversation expands the transcript while searching.
This presentation applies to primary agent conversations and new threads without
changing stored history or transcript exports.

Subagent activity uses one claw shape throughout its lifecycle: muted and still
while queued, animated while running, briefly green after completion, and dimmed
after cancellation. Failed tasks add a small warning badge; timed-out tasks add
an amber clock. Hover for the exact status, which is also available to VoiceOver.
Names stay free of status suffixes, and unnamed tasks appear as **Subagent**.
Reduced Motion keeps the running claw still. Existing detail expansion and
completed-task retention are unchanged.

## Pending questions and approvals

Thread rows, agent rows, and collapsed group headings show a question or approval
button for their oldest pending request. Parent threads include pending requests
from their descendants. Hover for the preview and the number of additional
requests of the same kind, or activate the button to read the full preview without
switching conversations. VoiceOver exposes the same details.

Approval previews include command, plugin, and system-agent requests from the
window's Gateway. They refresh after reconnecting and clear when resolved or
expired. Multiple windows for the same Gateway share that queue; different
Gateway connections keep their requests separate. Previewing a request does not
approve it or expand the actions available in the existing approval surfaces.

## Sources

Completed answers in native chat and Quick Chat show up to eight compact
**Sources** cards for cited pages returned by web search or web fetch during
that answer's run. Click a card to inspect the recorded **Search snippet** or
**Page excerpt** in a popover, then choose **Open source** to visit the page.
Cards without recorded excerpts say so; opening a source preview does not
retrieve the page again.

Source icons follow the Gateway's automatic favicon preference and use its
authenticated favicon service, with a globe when disabled or unavailable.
Session links and GitHub issue or pull request links keep their existing cards.

## Diagrams

Completed fenced blocks labeled `mermaid` render as diagrams in native chat,
including Quick Chat. Rendering runs locally using bundled assets. A fence is
complete when its closing delimiter arrives or the response finishes; incomplete
streaming fences remain code.

Use the small options button at the top right to view or copy the source and
expand the diagram. The copy button also appears on hover or keyboard focus.
Click the diagram to open its vector preview, where you can zoom and pan. Close
the preview with its close button or Escape. In Quick Chat, closing the preview
returns to the reply; clicking outside both the bar and its preview dismisses
Quick Chat.

Invalid or oversized diagrams keep their source readable. Temporary rendering
failures offer **Retry diagram** in the options menu.

## Session colors

Right-click a session in the sidebar, or open its menu-bar session submenu, and choose **Color**. Select red, blue, green, yellow, purple, orange, pink, or cyan. **Default** clears the color.

A colored session has a narrow leading stripe in sidebar and menu-bar rows. The open chat title uses a labeled activity state instead of a color dot. Unset colors show no stripe. The Gateway stores color names, not hex values; the app adjusts their hues for light and dark appearances.

## Multiple Gateway windows

Open **Connection… → Gateways** to add or remove reusable Gateway profiles. Each
profile contains a private-network `ws://` or secure `wss://` endpoint with
browser sign-in or an optional token or password; credentials are stored in the
macOS Keychain. Entering a hostname in **Add Gateway** defaults to HTTPS.
For Cloudflare Access, **Connect** opens the default browser to establish your
personal session. See [browser sign-in and website launch links](/platforms/mac/remote#connect-with-your-browser).

Secure token/password profiles maintain their own system-trust-gated first-use certificate pin
and do not inherit `gateway.remote.tlsFingerprint` from the primary Gateway.
Dashboard windows enforce that same saved-profile pinning policy.
Browser sessions use normal HTTPS trust and remain bound to their authenticated
Gateway origin, including its port. Each browser-authenticated profile has its
own dashboard browser data, isolated across named app profiles. Manual
token/password profiles retain their existing browser store and preferences.
Signing in with your browser starts a personal store without copying credentials
from the shared browser store. Mac tabs in a browser-authenticated dashboard
use a separate temporary browser session, shared by that window's Mac tabs.
Removing a profile closes its native chat and dashboard windows and shuts down
its secondary connection.
Updating a saved profile's credentials refreshes its open dashboard windows.
Use **Reconnect** to renew an expired browser session. Reconnecting the same
account retains its browser preferences. Changing accounts or removing a
browser-authenticated profile clears its isolated dashboard browser data;
removing any profile also removes its saved credentials.

If images or files prompt you to **Sign in to continue loading content**, choose
**Sign in** in the Mac app. The app renews the affected Gateway's session and
returns to the open conversation. Signing in to an ordinary browser tab alone
does not refresh the Mac app's separate browser session.

Choose **File → New Gateway Window…** or press Cmd-N, then select a Gateway.
The picker includes the primary Gateway, **This Mac** when it also hosts a local
Gateway, and saved profiles. It remembers the selected Gateway. Every selection
creates a new independent window in the chosen Web or Native experience, so the
same Gateway can appear in multiple windows with different active sessions and
navigation state.

The main **Gateways** menu is always present. It lists the primary Gateway, when
configured, then **This Mac** when available and saved Gateways, with Command-1
through Command-9 in that order. Select an item to open its window in the chosen
experience or bring its existing window to the front. Hold Option for **New …
Window**, or use Option-Command with the same digit, to open another independent
window. Cards show health, version and shortened build ID, endpoint, latency, and
open window count for the selected experience. Browser-authenticated profiles
show **Access** and session expiry. A **Primary** badge identifies the primary
Gateway, and a front-window marker follows the selected experience's frontmost
window. **Manage Gateways…** opens **Connection → Gateways**, even when the list is
empty. For SSH-tunneled primaries, the primary row uses the SSH host name rather
than the loopback tunnel endpoint, unless a matching saved Gateway supplies its name.

Right-click the OpenClaw Dock icon for **Open Dashboard** and **Settings…**.
When more than one Gateway is configured, this menu also lists every Gateway;
the checkmark follows the selected experience's frontmost Gateway window.

The menu probes health only while open, retaining cached facts between openings.
Before the first result a card shows **checking…**; failed probes show
**unreachable** and the last successful contact time when known. Closing the menu
cancels in-flight probes and closes idle probe connections for saved Gateways with
no open Web or Native windows. It never disconnects the primary Gateway.

The app also reopens your selected Gateway in the chosen experience after an app
restart.
Choosing **Primary** switches startup back to the primary Gateway. Background
connection refreshes do not change this selection.

Windows for the same saved profile and browser account share a Gateway
connection, transcript cache, offline outbox, and route leases while staying
independently navigable. Renewing that account's session preserves its queued
messages. Switching accounts closes the old account's native chat windows;
its cached history and queued messages stay with that account and are available
when you sign back in. Token/password profiles retain their profile-scoped
cache and device authentication. Windows for different profiles stay connected
and run chats simultaneously.

The menu-bar app's configured Gateway remains the owner of Mac node
capabilities and Talk Mode. Additional Gateway windows are operator-only, so a
second Gateway cannot silently retarget global microphone or device controls.
Listen/TTS and normal chat actions use the window's own Gateway connection.
Inline widgets also load from that window's Gateway.

### Gateway picker

In the Web experience, the sidebar identity menu lists the Mac app's configured
Gateways, with health, primary, and current-selection indicators. The selected Gateway shows a checkmark
in place of its shortcut hint. Other rows among the first nine show **⌘1–9**
shortcuts in native Gateway menu order; later rows have no shortcut hint.
Choose a Gateway to replace the current dashboard in the same window, or
Command-click or Control-click it to open a separate dashboard window. **Set as
primary…** makes the viewed token-authenticated profile the Mac app's primary
Gateway after confirmation. The app replaces the primary Gateway's credentials
and closes its native chat window; independent saved-profile windows stay open.
Dashboard windows displaying **Primary** follow the new connection, including
windows opened separately. While connected, the sidebar footer also shows the
current Gateway and marks it when it is primary. Password-only and browser
sign-in profiles can be viewed but cannot be made primary.

Dashboard commands such as New Session and the command palette act on
the frontmost Gateway window.

Native approval cards and dialogs apply only to the Gateway connection that
requested them. Changing Primary does not transfer a pending approval to the
new Gateway.

Manage channels, Gateway configuration, skills, and cron jobs in the Dashboard
for the intended Gateway. **Settings…** (Cmd-,) opens web Dashboard settings in
either experience; **Settings → This Mac** controls this Mac's local capabilities
from any embedded Dashboard window. **Connection…** remains native so you can
repair connectivity without a working Dashboard.

## Quick Chat bar

Press Option-Space (⌥Space) or choose **Quick Chat** from the menu bar menu to open a floating composer for the main session. Open **Dashboard → Settings → This Mac → App** to change the global shortcut in a native recorder panel, then choose **Done**.

Quick Chat shows the targeted agent (avatar or emoji, with the agent's name as the placeholder) and sends to that agent's main session. Its two-row composer keeps the draft above attachment, model, thinking, dictation, and send controls, matching the web chat layout. After Return accepts a send, the bar stays open and reveals the streamed Markdown reply and recent transcript above the same composer. The chevron expands or collapses the conversation without clearing the draft or interrupting the reply. Completed task details scroll with the transcript instead of occupying the writing area. Press Command-Return to send and open the same target in the full chat window, Shift-Return for a newline, or Escape to dismiss the whole bar and reply area. Clicking outside also dismisses it. Connection messages appear only when attention is needed. When relevant macOS permissions are missing, an attached strip offers **Grant** and **Not now** actions.

Use the microphone button to dictate into the composer. Partial speech results replace the dictated span live while preserving text that was already in the composer. Press the button again, Return, or Escape to stop; sending, hiding, or unfocusing Quick Chat also releases the microphone. The first use asks for macOS Microphone and Speech Recognition access. Quick Chat uses Apple Speech and may use its network services; only passive Voice Wake requires on-device recognition.

The model control shows the target session's current model. The separate **Effort** control opens a stepped thinking slider with the levels advertised by that model, plus Fast mode when supported. Drag the slider or use its arrow keys to choose a level; **Use session default** restores inherited settings. The context ring shows the conversation's usage when available and offers **Compact Thread**. A model choice updates that session and therefore persists there, while a reasoning choice applies only to each message sent from the current Quick Chat presentation. Local choices reset when the bar hides. Switching agents or choosing a recent session keeps explicit choices but reloads the newly targeted session's underlying model state.

Click the history button to choose from the five most recently updated sessions or return to **New message to &lt;agent&gt;**. A recent selection sends to that exact session and changes the placeholder to **Reply in &lt;session&gt;**. Hiding Quick Chat resets this temporary target to the selected agent's main session; switching agents from the avatar menu also clears it.

Command-Return opens the conversation of the agent that received the send in the selected Web or Native experience, including when session scope is global.

Choose **+ → Capture a screenshot** for **Capture Window…** or **Capture Area…**. Window capture labels every visible window; area capture dims each display while you drag a region and shows its live size. The selected screenshot is sent to the chosen agent with any typed text as its caption. The first use asks for macOS Screen Recording access. Escape, clicking empty space, or clicking without a meaningful area drag cancels.

Choose **+ → Attach text from &lt;app&gt;** to attach text from the focused app's focused window. Quick Chat shows the result as a removable context chip rather than placing the captured text in the composer; sending appends the chip's text to the outgoing message and then clears it. This requires macOS Accessibility permission. Attached text also clears whenever Quick Chat closes, so context from one presentation cannot leak into a later send.

After a reply finishes, choose **Paste to &lt;app&gt;** to copy its visible assistant text, excluding hidden reasoning, to the general pasteboard and paste it into the app that was frontmost. This requires macOS Accessibility permission. The action replaces the current pasteboard contents and then hides Quick Chat.

Disable the feature entirely under **Dashboard → Settings → This Mac → App**; the same section opens the shortcut recorder.

- **Local mode**: connects directly to the local Gateway WebSocket.
- **Remote mode**: uses the configured direct `ws://`/`wss://` route or the app-managed SSH tunnel as the data plane.

## Launch and debugging

Run the commands below from the repository root in a POSIX shell such as `zsh`
or `bash`, after `./scripts/package-mac-app.sh` has produced `dist/OpenClaw.app`.

Dashboard launch links also use the selected experience. Links inside the
embedded Dashboard can open the app with either a pointer click or keyboard
activation. Agent-action and Gateway-setup links keep their existing run and
connection confirmation rules.

- Manual: menu bar → **Open Dashboard**, using the selected experience.
- Auto-open for testing:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --chat
  ```

  (`--webchat` is accepted as a legacy alias.)

- Logs: `./scripts/clawlog.sh` (subsystem `ai.openclaw`, category `WebChatSwiftUI`).

## How it is wired

- Data plane: Gateway WS methods `chat.history`, `chat.message.get`, `chat.send`, `chat.abort`, `chat.inject`, plus `question.list` and `question.resolve`, and events `chat`, `agent`, `presence`, `tick`, `health`; question cards follow `question.requested` and `question.resolved` events and refresh from `question.list` after reconnects.
- `chat.history` returns a display-normalized transcript: inline directive tags are stripped from visible text, plain-text tool-call XML payloads (`<tool_call>`, `<function_call>`, `<tool_calls>`, `<function_calls>`, including truncated blocks) and leaked model control tokens are stripped, pure silent-token assistant rows such as exact `NO_REPLY`/`no_reply` are omitted, and oversized rows can be replaced with a truncated placeholder.
- Session: defaults to the primary session as above; the UI can switch between sessions.
- Session groups: `sessions.groups.list`, `sessions.groups.put`, `sessions.groups.rename`, and `sessions.groups.delete` own the path-free group catalog. Write-scoped `sessions.groups.defaults` and `sessions.groups.update` own optional New Session folder/worktree defaults. Membership is the session `category` updated through `sessions.patch` or assigned during `sessions.create`.
- Unread state: after a session activates and its live history loads successfully, the app clears the unread state it observed. A manual unread marker created while that session is already open remains through refreshes and run completion; leave and reopen the session, or mark it read explicitly, to clear it. Failed history loads do not clear unread state, and a transient patch failure retries on the next activation. During staggered upgrades, an older active app can still send a bare read acknowledgement that clears the marker. Cross-client protection therefore requires every active app to support the acknowledgement contract; update all connected clients before relying on the reminder.
- Onboarding uses a dedicated session to keep first-run setup separate.
- Offline storage: recent sessions and transcripts are cached per Gateway in `~/Library/Application Support/OpenClaw/databases/gateway-cache.sqlite`. Client-owned pending commands and routing state live separately in `client-state.sqlite` in the same directory. Cold opens paint cached transcripts before the connection is ready and refresh once the Gateway responds.

## Security surface

- Remote mode forwards only the Gateway WebSocket control port over SSH.

## Known limitations

- The UI is optimized for chat sessions, not a full browser sandbox.

## Related

- [WebChat](/web/webchat)
- [macOS app](/platforms/macos)
