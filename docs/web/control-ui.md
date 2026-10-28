---
doc-schema-version: 1
summary: "Browser-based control UI for the Gateway (chat, activity, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
sidebarTitle: "Control UI"
---

The Control UI is a small **Vite + Solid** single-page app served by the Gateway:

- default: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)

`gateway.controlUi.enabled` hot-applies. Disable it to stop serving dashboard
pages and assets while bots and existing Gateway connections keep running.
Re-enable it to resume serving; missing assets are prepared in the background.
Changing the serving base path or asset root still requires a Gateway restart.

For unmatched HTTP paths, the app-shell fallback respects the request's `Accept` header. An explicit HTML rejection such as `text/html;q=0, */*` overrides the broader wildcard, so the request reaches the startup `503` or final `404` response. Headerless and wildcard-only requests retain the browser navigation fallback.

It speaks **directly to the Gateway WebSocket** on the same port.

Chat portraits keep a fixed frame while images load. Previously verified
same-origin portrait URLs reuse the browser image cache within the admitted
operator's connection scope when using ambient authentication. Unknown URLs and
missing images share the avatar loader's requests and retry handling. Initials
remain beneath the image and are visible if it fails.

Optional surfaces follow the permissions granted to the current connection.
Session-only roles do not load the plugin UI catalog, Side Chat history, observer
visibility, or remote session-link titles. Side Chat is hidden, and session links
keep their locally available labels. MCP Apps discovery requires general write
access. The Gateway continues to authorize every request.

When the Gateway starts with `OPENCLAW_CONFIG_READONLY=1` or `OPENCLAW_NIX_MODE=1`,
its Control UI shows **Gateway configuration is read-only.** You can inspect the
configuration there. OpenClaw refuses changes to `openclaw.json` through the Gateway.

By default, the banner tells operators to update the configuration file or
deployment settings for this Gateway. To direct them to your own workflow, set
`OPENCLAW_CONFIG_READONLY_NOTICE` in the Gateway's startup environment. Its plain
text replaces the instructions after the read-only heading. End the notice with
a space and an absolute HTTP or HTTPS URL to add a **Learn more** link. For
example, `Edit the deployment manifest and redeploy. https://example.org/gateway`.

## Command palette file attachments

Open the command palette with **Cmd+K** on macOS or **Ctrl+K** elsewhere. Drop
images or files onto the palette, or paste images into its input, to prepare a
new background session without changing your current conversation or composer.

The first attachment switches the palette from navigation to **New session**.
Add optional instructions, adjust the session settings, then choose **New session**
or press **Cmd/Ctrl+Enter**. Dropping a file does not start the session by itself.
Files remain visible while preparing. If a file is rejected, an error toast
explains the failure and only that file is removed. You can manually start a
session with the remaining text and files; a rejected file cancels a pending
automatic start. File admission and size limits match the chat composer.

Closing the palette keeps its attachment draft in memory for the same Gateway
and account. Removing the final attachment keeps new-session mode while
instructions remain; clearing both files and instructions restores navigation.
Reloading or leaving the app does not preserve this in-memory draft.

## Automatic session names

New Dashboard conversations receive a title from their opening task. Later messages
keep that title. Only an explicit rename by you or the agent through `sessions.patch`
changes it. The open conversation URL updates when its name arrives or changes,
without reloading the page or adding a browser-history entry.

## Temporary disconnections

When the connection drops, the Control UI keeps loaded catalogs, automation
editors, Memory Import selections, Activity history, Dreaming results, approval
queues, and open board and portal documents in memory. A transport interruption
does not reset those page-local drafts. The connection indicator at the bottom
left shows the connection state; retained data may be out of date until reconnect.
While automatic reconnection is running, the indicator shows **Reconnecting…**
with the sidebar's standard spinner and without a Retry button. **Retry** remains available when automatic recovery stops.
A required page refresh keeps its separate refresh action.

A saved chat can restore its archived or read-only composer and parent breadcrumb
while reconnecting. These saved display facts never authorize actions; live session
state replaces them when the connection returns.

If a chat side panel fails to load, its Close control remains available independently of the failed panel. Closing it keeps the conversation and its draft in place without reloading the page. Retry still respects unsaved work that blocks document reloads.

Gateway actions, including saving edits and approving requests, require a live
connection. Reconnecting refreshes retained data without automatically replaying
those actions. Memory Import keeps explicit deselections when refreshing its
plan. Session rename and new-group dialogs keep typed text across a temporary
disconnect; failed submissions stay open for review and retry.

Switching Gateway or account, signing out, or losing access clears the affected
data and drafts. This retention does not add offline persistence or guarantee
that page-local drafts survive a reload or closing the tab.

## Browser requirements

Use Safari 26.2 or later on macOS 26.2, iOS 26.2, or iPadOS 26.2 or later,
or Chrome or Firefox released within the last six months (Chrome 147+ and
Firefox 150+ as of October 2026). Embedded web views need the same browser capabilities.

Browsers missing required overlay features show an update screen before the
dashboard starts. In the native apps, **Open in browser** opens the current
page in your default browser. Update the browser or operating system if that
browser also shows the update screen.

In **Settings → Appearance → Browser tab icon**, choose **Agent avatar** to use
the selected agent’s image. The **Shape** row offers **Square**, **Rounded corners**,
and **Circle**. Square preserves the full image; rounded and circular icons use a
centered crop. The choice is saved with your tab-icon preference, and activity
badges remain visible on every shape.

After a Gateway restart, an agent may need a few minutes to prepare its database. The chat view shows "Starting up" and the sidebar stays quiet while preparation is pending. Both reload automatically when the agent is ready; an actual preparation failure still shows its diagnostic and repair instructions.

If the New Session page fails during its initial render, the UI attempts one automatic page reload per browser tab. A repeated failure shows **Retry** instead of starting a reload loop. Automatic recovery is skipped if session storage is unavailable, the serving document cannot be reached, or unsaved work blocks reloading. Errors after the composer has rendered use in-page retry instead.

Reloading a previously visited chat restores the last settled sidebar while the Gateway reconnects. Pinned sessions, plugin rows, roster order, filters, and your display identity keep their places until live data is ready. The footer still reports the current connection status. This browser cache is scoped to the Gateway and profile, expires after 30 days, and excludes incognito sessions. The same snapshot provides the saved session rows and routing defaults for the first chat header. Cached rows never authorize session changes. Sidebar snapshot capture coalesces live updates during idle time and flushes pending changes when the page is hidden or left.

The saved sidebar also retains unread marks, activity and attention glyphs, pull-request badges, and the Inbox count. Live facts replace this display projection together with the rows; pins outside the roster retain their saved presentation until their own details arrive. The Inbox button reserves its place while connecting.

Message reactions share the message footer. Desktop Chat Details lists automations after session information and task progress so arriving automation results keep those sections in place. The mobile composer reserves one activity row so arriving task and subagent status does not move the transcript.

A short transcript loads at most one older page automatically when you open or reload a chat. It stops once the visible area is filled, without filling the backscroll buffer. Scroll up or choose **Show earlier** to continue loading older messages, even if the transcript still fits on screen. A reader action checks up to three consecutive pages when entries are empty, overlapping, or hidden by display preferences; longer hidden intervals remain available through another action. Transient read failures retry within the existing one-minute history-recovery budget, honoring the server’s backoff. Permission denials are not automatically retried. The touch-friendly history control keeps keyboard focus during loading and ignores repeated activation. Failed reads show **Retry earlier messages** at that same boundary without removing the loaded conversation. While disconnected, the control shows **Waiting for connection…** instead of accepting a click that cannot load history.

GitHub item URLs and repository-qualified references such as `owner/repo#126` render as compact links. Use `PR owner/repo#126` for a pull request or `issue owner/repo#126` for an issue. References identified by keywords, such as `PR #126`, remain plain text without a repository qualifier. Project display names, the checkout, the project catalog, and other messages do not supply a destination. A standalone hash token that is also a valid hexadecimal color, such as `#126`, retains its color preview without a GitHub link.

GitHub polling uses conditional requests when GitHub supplies an ETag. Unchanged responses reuse parsed metadata without downloading the body again. Reuse is bounded and isolated by API endpoint and credential; every refresh still checks GitHub and the current access rules. Authenticated `304 Not Modified` responses do not consume GitHub’s primary REST rate limit.

The cached transcript also preserves its conversation title and selected model label when the conversation is outside the saved sidebar page. You can type in the restored draft while the Gateway reconnects. The saved model control shows “Refreshing models…” and stays disabled until live catalog data arrives. Live session metadata replaces that display projection when it arrives. Reloading a full-UUID chat link can show that scoped cache while the Gateway confirms the route. Sending and restored queued messages wait for confirmation; a deleted or moved conversation replaces the cached view with the Gateway's result.

An authenticated same-origin reload includes shared display settings and your profile’s appearance and sidebar preferences in the document. Chat uses this display projection while connecting, without loading the full editable configuration. Preference changes from other tabs refresh through the Gateway’s existing notifications; settings pages and configuration writes still load the full snapshot.

Saved pin labels remain visible while their details refresh, even when those sessions are outside the first list page. Unavailable pins disappear silently without removing their saved shortcuts. Sidebar session updates arriving within one display frame paint together. Sidebar refreshes reuse unchanged session rows while still receiving current counts, defaults, and filters. Reconnecting can reuse those rows when the same client retains their revision; changes to visible membership or row facts return a fresh page.

Inline widgets and MCP Apps reserve their last rendered height when a cached conversation reloads, so loading their content does not move the surrounding messages. New widgets use their declared size until the content reports its height. Changed content or a different window width can still resize a widget.

On a dashboard reload, a saved widget with an unexpired view ticket can load its document while the first Gateway connection is pending. Gateway-backed actions still wait for the connection, and loading pauses if the Gateway goes offline. Expired tickets require a fresh ticket from the Gateway.

Fixed-height Board reports render their content as you scroll near them, while reserving their full card size. Once loaded, reports stay mounted when you switch tabs. Auto-sized reports render immediately so their content determines their size.

Transcript history loads in parallel with the browser cache. An unchanged history response keeps the cached message rows and widget sizes in place. The transcript restores its saved reading position, or opens at the end, before showing its initial measured rows. Measured rows become visible once their selected geometry is committed, without an extra layout frame.

When saved row sizes match the current content, appearance, and pane width, the initial viewport and its nearby rows mount together. Rows without matching saved sizes are measured incrementally.

Consecutive informational system, recovery, and model-fallback events appear as a collapsed **system events** row in chat. Expand it with a click, Enter, or Space to read the original events in order. An amber **Updates not delivered** summary stays visible when delivery needs attention; event counts do not imply a count of undelivered updates. Human and assistant messages, actionable notices, and search results remain separate. This changes presentation only, not retry or delivery behavior.

During connection recovery, Send shows its busy state and explains why sending is unavailable without inserting a temporary notice above the composer.

Automatic read acknowledgements and identity refreshes pause while the Gateway reports a restart or suspension. Pending read acknowledgements are shared across repeated session updates. If an acknowledgement is rejected, later updates respect the server's retry delay and use randomized backoff instead of immediately sending another patch.

Reconnect bootstrap reads also pause together: agent identity, session subscriptions, session groups, pending questions, and the session list. An announced restart or suspension holds these reads until readiness or a new connection resumes loading. If a restart rejection arrives without an announcement, one delayed probe at a time checks for recovery after at least a minute, in case the restart is canceled. Writes are never replayed by this mechanism.

Agent identities are shared across views on the same connection and refresh after configuration or agent changes, including `IDENTITY.md` saves through the Gateway, rather than expiring while a tab is idle. Reload the tab to pick up direct filesystem edits to workspace `IDENTITY.md` or avatar image files.

If the Gateway's request queue is full, automatic sidebar session discovery keeps the current rows and retries up to three times, respecting the server's retry delay. A persistent failure shows "The server is busy. Please try again in a moment." Other actions can show this message immediately; wait briefly, then retry the action.

While the initial connection or a route loads, shimmer placeholders reserve the chat layout. Home and System busyness open directly in their destination panels, with working headers and Close controls while the content loads. Brief loads do not flash placeholders; slower loads show placeholders inside the panel, and load errors offer Retry in the same place. The rest of the page stays usable. Drag the System busyness title bar to move the panel; its position is remembered in this browser. You can also focus the title bar and use the arrow keys (Shift moves farther). Compact/expanded transitions animate briefly, respect reduced motion, and keep the panel inside the window. Loading indicators respect your theme and reduced-motion preference; Gateway startup progress remains visible when available.

The selected chat loads before automatic sidebar session lists refresh. Live events remain subscribed during startup, and explicit sidebar actions remain available. Background lists resume after the transcript loads or reports an error. Accepted new sessions refresh the visible sidebar immediately, including **Involving me** and owner filters, without waiting for the chat to finish loading or the agent to finish working.

A foreground create uses its reply to keep the confirmed title and an actionless current-session display row available independently of the sidebar refresh. This display row does not add the session to filtered membership or counts; those still come from the Gateway. The first message and run status appear from local submission facts and live events without waiting for the list refresh.

After the current page and transcript are ready, the browser can prepare code for
Pages, New Session, and common dialogs during idle time. Hovering or focusing a
navigation link, the Settings menu item, the command-palette button, or the model picker prepares
that destination sooner.
Navigation preparation pauses while a page loads, the tab is hidden, or the
connection is offline, and respects the browser's Save-Data setting. Page data
still loads through its normal navigation flow. Hashed assets remain cached for
repeat visits without revalidation; an update uses new asset URLs.
The service worker owns [offline asset storage](/web/control-ui/offline-and-reconnect);
navigation hints also prepare modules for the open page. These hints take priority
over the worker's bulk download, which resumes after page requests settle.

If the selected session changes while its message subscription is being admitted, chat retries that read with fresh access checks for up to one minute. Saved replies load after the subscription succeeds, without resending your message. Switching chats or losing access stops recovery; a persistent failure leaves **Retry** available.

Use **Snooze → Choose another time** in a session menu to pick a future date and time in your browser’s local time zone. After a successful snooze, **Custom** shows that exact date and time in other session menus for one hour. Choosing another custom time replaces it; presets and Undo leave the remembered choice unchanged. The browser stores this choice separately for each Gateway and signed-in account, and removes it when it expires or the wake time passes. If browser storage is unavailable, the choice remains reusable only in the current page.

The chat header’s **Details** panel groups session information into collapsible sections separated by subtle dividers. **Environment** shows the workspace name, branch, worktree, execution device, and model. Absolute workspace paths stay out of the panel text and tooltips; use **Copy path** when you need the full path, copy the branch, or open **Show session files** to browse the workspace. The composer's context ring shows a compact usage breakdown, latest-run tokens, and provider plan limits. **View context** opens the complete report, Refresh, and compaction action in one side panel. Approximate usage keeps its `~` marker. **Changes** keeps pull requests, change totals, checks, and available publication actions together. Background tasks, automations, participants, and task progress retain their existing session-scoped actions. On wide conversations, Details docks beside the transcript; narrower conversations use a dismissible popover below the header. On desktop, use the **Details** toggle to open or close the panel; mobile keeps a close button inside the panel.

Session details share concurrent reads across the sidebar, chat, and resource panels. Returning to a session reuses its details on the same connection, including updates received through complete session snapshots. Incomplete updates, explicit refreshes, and reconnects fetch current details; failed reads remain retryable.

Sidebar pull-request indicators reuse the last known snapshot. Subscriptions acknowledge the requested sessions immediately; session preparation and fresh pull-request snapshots arrive through background updates. Opening a session, its progress card, or its Git activity requests current checkout facts; sidebar rows alone do not poll Git. Active panels detect branch and staged changes from Git metadata. Tool completion refreshes working-tree stats, with a five-minute fallback for edits made outside OpenClaw.

Changes summaries share identical concurrent polls and reuse unchanged checkout results when file metadata can establish freshness. Summary reads have a separate worker queue from full patches and PR statistics, with priority inside the shared Git child limit. Running Git commands still finish normally, and background work keeps making progress.

If session metadata takes more than two seconds to load, the Changes panel keeps waiting and polls again while that shared read finishes in the background. An empty pending response does not mean there are no changes. The completed diff still requires current session and workspace access.

When a checkout is too large or its Git layout cannot be validated cheaply, summaries reuse the last result for up to ten seconds before probing again. Missing or unavailable checkouts retry after one second. Full patches still require fresh revision validation.

Nested repositories remain separate from the parent checkout's file contents. Untracked repositories appear as directory entries, while tracked submodules report Git's change status. Unchanged results can be reused in both cases, including when the checkout uses an external `core.excludesFile`; editing that ignore file refreshes which files appear.

In the chat’s **Changes** panel, gutter chevrons fold complete functions, classes, and other language-supported multiline blocks within a file. Everything starts expanded, including edits. A folded placeholder shows the hidden line count and additions/deletions; click it to expand. Split and unified views share the same folds. The file menu offers **Collapse Code**, **Collapse Functions and Classes**, and **Expand Code**, separately from collapsing whole files. Incomplete source, omitted gaps, unsupported languages, and oversized previews stay expanded. Changing the patch resets code folds.

Session-start baselines omit SQLite databases and their WAL, SHM, and journal files, as well as hardlinked files. These files remain visible in checkout diffs even when unchanged since the session began; baseline capture never opens them in the Gateway process, preserving live database locks.

Background pull-request comparisons use local Git objects and never fetch missing history or blobs. If a partial clone lacks objects needed for the comparison, statistics can remain unavailable until those objects are fetched. A timed-out comparison skips its dependent checks, keeps the branch visible without statistics or a Create PR link, and logs a warning to fetch repository history and retry.

The sidebar’s **Online** list shows compact person rows with avatar presence indicators: solid green means active, amber means idle, and a hollow green ring means connected with activity unavailable. Names stay on one line and fade at the edge when space is tight. The indicators, hovercard, and accessible description preserve the activity distinctions. A compact group at the end of each row shows a theme-accent spinner and running count, then a small message-circle icon and muted open count. Each icon-number pair uses tabular digits and keeps its natural width, with a wider gap between running and open groups. The group rests at the right edge; names and counts share a text baseline, without fixed digit columns. Counts have no pill background at rest, with explanatory tooltips; hovering or keyboard-focusing the row reveals a subtle grouping pill without shifting the content. Reduced motion keeps the spinner still. Known zero counts are omitted. Open counts each person’s owned, unarchived conversations that you can access across configured agents, excluding hidden subagents, automation, system, and global/unknown sessions. Running counts each conversation once while its own agent turn executes or its delegated subagents remain active, including when the parent is waiting for their results. Queued direct turns without active delegated work do not count. Counts cover the matching sessions before pagination and do not change with your session-list filters. By default, all connected people remain visible, ordered Active, Idle, then Online with activity unavailable. Hover the **Online** block or focus it with the keyboard to reveal **Filter & sort**; the action stays available on touch devices. Its compact menu uses the existing dropdown controls: choose **All** or **Running**, and sort by **Active people first**, **Running sessions**, **Total sessions**, or **Name**. Mouse hover opens the choice submenus; selecting an option dismisses the menu. Count sorts put larger values first and unavailable counts last; **Total sessions** uses the open count above, not lifetime history. **Reset to defaults** appears only after a setting changes, below a single separator, and restores the default view. These controls only filter or order people; they do not change session-list queries or hide either counter. Unavailable counts show no placeholder; the row tooltip and accessible description identify them as unavailable rather than zero. A failed refresh keeps the last counts with a retry notice.

Person hovercards keep their **Recent sessions** selection and order stable while open, so background activity does not move links under the pointer or keyboard focus. Reopening the card selects the latest sessions. Timestamps stay live, and sessions that leave the visible, eligible roster disappear without replacing them with other sessions. **Viewing now** continues to follow presence.

Sidebar live narration pauses while the browser tab is hidden and resumes from current activity when you return. The selected chat and pending outbox keep their separately owned subscriptions.

**My sessions** and specific-owner selections list that owner’s sessions across configured agents, independently of the chat or workspace you are viewing. Other agent-scoped sidebar lists refresh immediately when you switch agents, even while the selected chat is still loading. Automatic startup and reconnect refreshes continue to wait for that chat to become ready.

Sidebars apply live updates to loaded sessions without periodic list reads while ownership and list membership remain unchanged. Ownership changes, new sessions, incomplete event coverage, and broad invalidations still refresh the authoritative list. Matching views share the same managed query, and refreshes reuse retained row revisions when available.

In **My sessions**, choosing an agent from the switcher resumes that agent's newest loaded active conversation from your list, or opens its Home when none is loaded. Agent unread indicators and Home activity use the same current list; Home controls keep their separate main-session behavior.

The sidebar’s **Unsent draft** pencil covers saved text, attachments, replies, and goals, including drafts saved in another tab or before a reload, without reopening the conversation. A newer edit or clear always replaces an older saved draft. Incognito conversations never show a saved-draft pencil. Outbox attention badges also count queued messages with attachments that need review once the connection finishes restoring.

If this browser has saved drafts or messages that could not be restored to a chat, a **saved drafts** or **saved messages to review** notice shows their content and attachment names. Empty records are not counted. The original chat is named only when it can be identified from your available conversations. Choose **Review in this chat** in a non-Incognito chat with an empty message box and no pending messages; confirmation restores the saved copy without sending it. Messages with unconfirmed delivery stay paused—check the original chat before retrying. **Delete saved copy** asks for confirmation and removes only the saved draft, messages, and attachments shown together, not messages already sent to a chat.

With sidebar previews enabled, running sessions show a small, static tool icon beside the progress text on the second row beneath the session name. The title row stays unchanged, and the tool name is available only in the icon’s tooltip and accessible label rather than repeated as visible text. The compact one-row sidebar and team roster add no tool icon or tool text, so tool changes do not shift the list. Tool progress uses only explicitly public progress text from the Gateway, never argument-derived metadata or raw command output. If a call’s progress becomes hidden, its displayed progress is withdrawn. Pending questions and other critical status keep their existing priority. The existing session indicator remains the only activity animation, and tool state clears when its live subscription ends.

Live narration retains up to six visible running background sessions, plus the open session. Recency changes keep that window stable; when a session finishes or leaves the visible rows, the most recent eligible session fills its slot. Reconnecting selects a fresh window.

If a narration subscription encounters a retryable failure or times out, it retries automatically with randomized exponential backoff, honoring the server's retry delay. Sidebar updates share the pending retry instead of sending more requests. Retries stop when that session leaves the narration window, the tab is hidden, or the connection closes; non-retryable errors wait for a new subscription intent or connection.

Failed narration releases use the same backoff, including while the tab is hidden. If a session is needed again, its queued release is canceled and its subscription is renewed safely. Closing the Gateway connection cancels release retries.

Closed Terminal, Browser, and Desktop panels initialize when you open them rather than during initial navigation. Home/Ask OpenClaw and System busyness keep lightweight frames ready and defer their conversation or diagnostic contents until opened. Home preserves its saved dock position and size throughout loading. Panels saved as open still restore after a reload. Settings does not automatically reopen Ask OpenClaw; its control and diagnostic actions can still open it explicitly.

Minimizing and reopening the Dashboard side panel preserves loaded MCP Apps and their unsaved in-app input while the app lease remains valid.

MCP Apps and Canvas previews also retain their loaded frames through a connection
blip to the same Gateway. Gateway-backed actions pause until reconnection; they
are not queued for replay. MCP discovery keeps its last results while offline.
If an app times out during initialization, use **Retry** to load it again.
Changing Gateway, losing access, or selecting different content retires the old
frame and its local state.

Hidden retained chats defer command and model metadata refreshes until you return to them. Returning to a recently opened chat reuses its completed metadata on the same connection until a Gateway change invalidates it. Concurrent readers share the same request. Session events with an unchanged model-selection revision retain the model catalog, and session-only changes retain agent commands. Native sessions without a model-selection revision wait for a 2.5-second quiet period after ordinary patches before refreshing the catalog and session facts. Explicit model, account, and runtime selections refresh promptly. Configuration and command changes refresh commands; catalog and session lifecycle changes refresh affected model choices. Agent-specific catalog changes retain other agents’ cached choices and pending catalog requests. Repeated changes during a request share one trailing refresh instead of issuing overlapping requests.

Deleting a session refreshes the roster and invalidates that session's model choices without reloading metadata for unrelated chats. Session action menus build their contents when opened.

Provider speed observations are tracked separately for each requested tier. Repeated identical responses retain the matching Fast or Ultrafast hint without refreshing every open chat's model choices. Recovery or expiry clears only the affected hint.

Metadata refreshes wait for an in-progress model-runtime replacement to publish. An agent whose model runtime is unavailable does not interrupt commands or model choices for healthy agents; its metadata becomes available when its owner publishes.

The model picker searches across the full catalog, including models under collapsed
providers and **All models**. Use the Up and Down arrow keys in the search field to
move through results and Enter to select one. Large catalogs keep the same search
and keyboard behavior while rendering only the visible portion of the list.

New Session keeps previously fetched model choices selectable while their catalog
refreshes in the background. Before the first catalog arrives, it does not turn a
configured default into a model option. Command palette model results use the same
catalog cache and appear independently of slower search categories.

Provider authentication status is shared across views and refreshes after account changes and near credential warning or expiry deadlines. Credentials without an expiry do not need periodic refreshes. Hidden tabs defer deadline refreshes until visible again.

The sidebar loads automation status once per connection and refreshes after automation or configuration changes. Failed reads retry once per minute while the tab is visible and stop retrying after success. Sidebar health and Automations page refreshes pause during announced restarts or suspension and catch up when the Gateway is available again. Overdue warnings advance on a local deadline without polling the Gateway. Hidden tabs catch up when visible; returning to an unchanged tab does not poll automations. Command palette searches reuse their automation inventory on the same connection until one of those changes or a reconnect.

In a session’s menu, open **View → Speech bubbles** to switch that conversation—including the main session—to two-sided bubbles. Your messages stay on the right and agent replies stream into bubbles on the left. The choice is saved per session in this browser; other sessions keep their own mode. Turn it off to restore the flat reply layout. In bubble mode, ordinary waiting appears only as **…**, without a status phrase or timer. Active work uses one compact bubble with its recorded purpose; parallel tasks share one bubble that expands into their current activity and session links. Click a work bubble to inspect its tool details. Approval and retry states remain visible, and finished work leaves an expandable receipt instead of animated dots. Agent reactions appear beneath the prompt they acknowledge, independently of the selected layout.

Automation inputs appear as compact, collapsed activity rows instead of message bubbles. Expand a row to read the full prompt and access its message actions. Each automation input stays separate, even when several jobs run in the same conversation. The expanded **From** link opens that automation's History tab and highlights the originating run; open the run's transcript from History when needed.

Thinking, speed, and context-window changes stay synchronized across panes showing the same session. While a change is pending, the latest selection remains visible. A rejected change restores the latest confirmed value. Delayed events from a replaced session leave the current transcript and unsent draft intact.

While an agent works, completed commentary or preambles appear inline in the
conversation when the model and runtime provide them. Narration keeps its
formatting and position alongside tool activity; the working indicator remains
a separate status for execution, startup, or approval. After a session is idle,
a new run starts its own Working timer, including when it starts outside the
Dashboard; earlier tool activity remains in the conversation. **Keep commentary** in
the chat view menu controls whether commentary stays visible after the run,
not whether the active run’s narration survives a history refresh. Completed
dashboard turns collapse their narration and tool activity under **Worked for …**
above the answer, with durations such as **Worked for 2 minutes, 3 seconds**.
Expanding it restores the sequence with the existing tool-call groups and shows
the total tool-call count. When no run duration is available, the heading reads
**Worked** rather than estimating from message timestamps. Failures and other
non-success outcomes remain visible even when collapsed, such as
**Worked for 2 minutes, 3 seconds · 2 failed**.

Still-streaming assistant text stays at the bottom of its run, below saved output, and
takes its transcript position once saved.

Accepted steering messages keep their saved transcript positions. Earlier saved
output stays above the message; later answers and live output appear below it,
including when the same run continues after steering. Reloading or reconnecting
does not move the message to the end of that run. Unsaved assistant text remains
one live tail until saved rows replace it; the UI does not split or rewrite
stored assistant messages.

Consecutive tool activity shares one expandable log, including when background
work resumes in a new run. Visible messages, media, and conversation markers
keep their place and separate logs; live response text and the working indicator
stay outside the log. Grouping changes only the presentation, not the transcript.

Inter-session messages appear as compact **updates from** activity rows instead
of chat bubbles. Consecutive updates from the same source share one row; other
messages and conversation markers keep them separate. Select the row to show
the original messages and timestamps in one step, or select the source name to
open that session. Search results and reply navigation reveal the matching
messages. This changes only presentation, not stored messages or run ownership.

When an incoming message causes an unstarted tool call to be skipped, its card
and work summary show **Skipped**, including after reloading the conversation.
Approval blocks and tool failures keep their separate outcomes. A failed command
with a reported zero exit code still shows **failed** in its summary and expanded
result. Nonzero exit codes remain visible as diagnostics; captured output and
reported exit facts are unchanged.

Failed replies show **Try again** at the right of the heading. A compact
**Copy error** icon beside the title appears on hover or keyboard focus, and
stays visible on touch devices. **Details** appears only when the diagnostic
contains more than the visible summary. To change models, use the model picker
in the composer; retrying continues from the existing conversation without
replaying the original request. Internal updates that return no answer keep their
failed-run diagnostics without adding a retry notice to an already successful
conversation. User-requested missing replies and actual provider or storage
failures still show their failure notice.

Open **Panels**, then choose **Subagents** to inspect child runs, including swarm
workers. **Details** also lists the conversation's subagents and opens a selected
child. Both entry points support keyboard navigation. An empty conversation starts
with the panel closed. New running batches stay collapsed until you open the panel;
closing it keeps it closed for that batch.
Finished results stay open until you close them. While the parent waits on
subagents, the conversation keeps each child’s claw, name, and current activity
together in one clickable row. A single muted timer at the far right shows total
time since your message, including subagent waits, when that request is known.
There is no second status line above the composer. When the conversation uses
a fallback wait indicator instead of named child activity, its clock measures
the current idle interval from the parent’s latest recorded run end, independently
of loaded handoff history. Active children alone do not invent a wait for a
parent that has never run.
The panel loads all child pages automatically and groups running and finished
work, keeping children waiting on their own
descendants under **Running**. It shows elapsed time and available tool activity,
and opens each child's existing view-only transcript beside the parent. Running
rows show public tool progress when available, otherwise the current tool step's
purpose (such as an exec call's title) or the run's latest status summary, along
with the call count. When only part of a long history is loaded, the count is a
lower bound such as **40+ calls**. Avatar-free child transcripts do not reserve
empty avatar columns, and narrow panes use compact horizontal insets while wide
transcripts retain the reading-width limit. It does not add rows to the left
sidebar. Follow delegated work in the **Subagents** panel rather than a separate
inline task tracker. A directly
opened child page offers **Open parent session**. The `/subagents list`,
`/subagents info <id|#>`, and `/subagents log <id|#>` commands remain available.

Open **Processes** from the chat header's **Layout** menu or the side-panel **+**
menu to inspect the conversation's background exec commands. It is separate from
**Subagents**. Running and retained finished processes show status and elapsed
time. **Finished** starts collapsed; click its heading to expand or collapse the
list. Selecting a process opens its recent output. **Stop** targets that exact
process, not the parent conversation or another command with the same name.
Details and Processes panels viewing the same session share one observation and
refresh when its background processes change. Changes are batched over five seconds;
a safety refresh runs after a minute without an update. Hidden panels and browser
tabs stop refreshing. Output follows the process owner's temporary
retention limits; viewing it does not drain output waiting for the agent.

Select a session's title in the chat header to rename it. Enter saves the name;
Escape cancels the edit. While an input method is composing text, Enter and
Escape stay with composition. Finish composing before saving or canceling.
Once the Gateway confirms a rename, the saved name stays visible while the session
list refreshes, even if an older snapshot arrives late.

Open group rename and **New session defaults** dialogs close when the Gateway
reconnects or you switch connections. Reopen the group’s menu to make changes
using the current connection.

**Sections** organize only your sidebar, for solo users, members, and guests.
They appear below **Pinned**, among the sidebar groups, marked with a stacked-layers
icon; deliberately empty sections remain visible. Choose **New section** in
**Filter & sort** even without selecting a session, or use a session's
**Add to section** menu to add it to an existing section or create one with that
session selected. Only your sidebar changes. Sessions stay in their groups.

Creating a section takes two steps. First name it and choose where its sessions
come from: **My sessions**, **Involving me**, **All sessions** (including
teammates'), or one project. Then pick sessions from that list; the search button
searches every session you can access, not only those loaded in the sidebar, and
teammates' sessions show their owner. **Edit section** opens on the session list;
**Back** returns to the name and source. Sessions inside a section follow the
sidebar's **Sort by** selection. Drag an existing session into a section to add it. Drag section headers
to reorder them, or use **Move up** and **Move down** in the section menu.
**Remove section** removes only that personal section; it never deletes sessions.
Pins and shared groups are independent, and **Move to group** still changes shared
group membership.

Sections do not grant access. Unavailable saved sessions remain hidden,
and sessions outside the loaded session list resolve through the normal access-checked
session lookup. Sections are scoped to your profile and Gateway. Connections with
general Gateway write access sync them through personal preferences. Session-only,
read-only, and profileless connections keep their edits in that browser, like personal pins.

Dragging a session between shared sidebar groups updates its placement immediately. A successful
save keeps that placement even if the subsequent list refresh fails; the UI reports
the refresh error separately. If a connection failure leaves the save unconfirmed,
refresh and check the session's group before retrying. Other clients' newer group
changes still reconcile through session events.

The sidebar keeps unread child failures visible on their ancestors. These warnings
name the child session that failed, even when its parent has finished or continues
working. Select the warning to open the child session and acknowledge its failure;
a subagent chat opens without adding a sidebar row.

Choose **Create new agent** in the agent selector to open a name-and-avatar
dialog. Enter a name and choose or generate a Blobster avatar. On submission,
the agent appears first in the list and its own chat opens immediately while
OpenClaw checks that inference is usable. If the check fails, OpenClaw explains
the problem and does not create an agent. After verification, it saves the agent
and a greeting that uses its name, then asks you to choose one role. The agent
follows up by asking for more detail about your goal before helping. Every
message stays in that conversation; leaving and returning resumes the same
chat. Its stable internal ID can appear in the URL, but never as its display
name or subtitle. The latest created agent stays first after a reload.

The selector starts with **Create new agent**, using a plus-circle icon, followed
by **Show all** when multiple agents are available. Compact avatar-and-name rows
fill a bounded, scrollable list. Each row's settings gear opens that agent's
existing settings without switching the selected agent. Reopening the menu
brings the selected agent into view.

## Download files

Chat filename links first try the named path. If a bare filename is missing there,
the preview opens a nested file only when a complete workspace search finds exactly
one matching filename. Ambiguous or incomplete searches keep the missing-file error;
use an explicit path to select the intended file.

Opening a file collapses the file tree to make room for its preview. Use **Toggle
file tree** to browse another file, or **Show in Files** to reveal the current file
in its folder with the **All** filter.

The **Review** file menu offers **Edit file** when the file reader confirms editing
is available. Readable files keep **Open File** and their supported Markdown and
source views when editing is unavailable; downloads remain available from the preview.

If the **Files** panel shows a listing error, select **Retry** to load the current
folder or search again. This keeps the session and query in place; access checks
still apply, and a failed retry displays its error.

In the **Files** panel, hover over a file or focus its row to reveal **Download file**
next to Preview and Copy path. The same action is available in the file preview
toolbar. It saves the original file through your browser without opening another
page; unsaved editor changes are not included. Files stream directly to the browser's
download manager, with no separate download-size cap. The inline-preview limit
still applies, but files too large to preview retain their download action.
Folders are not downloadable. Downloads require the Control UI and its Gateway
connection to share an origin (including a same-origin Gateway proxy).

Detected PDFs opened from chat file links or the Files panel use the same
browser-native preview as PDF attachments, up to 16 MiB. Preview failures and
larger PDFs retain **Download file**. Rendering depends on your browser's PDF
support; the generic text and image inline-preview limit is unchanged.

Downloads use the session's existing file-read access, including managed repository
workspaces. Provider-backed node workspaces whose bridge only supports whole-file
reads do not yet support downloads. Authorization errors appear in the UI; transfer
progress and failures appear in your browser's download manager.

To add an open file to your next message, choose **Attach to session** from the
file toolbar's **⋯** menu. The file appears in the existing message draft; it is
sent only when you send that message. Clean files use their original bytes.
Text files with unsaved editor changes attach the current edited text without
saving the file. Existing upload permissions and attachment size limits apply.
Switching the file or session cancels a pending read.

## Take a photo in chat

Choose **Add attachment → Take photo** in chat or New Session to open a camera
preview. Allow camera access when your browser asks, then choose **Capture**,
**Retake**, or **Use photo**. The chosen photo becomes a draft attachment; it does
not send the message. The preview stays in your browser and does not request
microphone access.

The live preview requires HTTPS or localhost and a browser that supports camera
access. On plain HTTP LAN addresses or browsers without the camera API, choose
**Use device camera** to open the native capture picker instead. This preserves
mobile camera capture without silently substituting a picker for the preview;
your browser decides whether it shows a camera or a file picker. If access is denied,
allow the site in your browser and operating-system camera settings and retry.
The explicit **Use device camera** option also remains available after a preview
request fails, including permission denial; it never opens automatically.
If no camera is available, choose **Upload photo** instead.

The camera stops when you capture a photo, close the dialog, or leave its draft.
File and photo uploads remain available through their existing pickers, including
the combined **Attach…** picker on iOS Safari.

## Watch a desktop in Picture-in-Picture

Connect the Desktop viewer, then choose **Open desktop in Picture-in-Picture** in
its toolbar. The browser opens a view-only, always-on-top window so you can watch
the remote computer while using other tabs or apps. The same action is available
in the docked panel, chat side panel, and focused desktop window.

This requires a secure context (HTTPS or localhost) and a desktop browser that
exposes the Document Picture-in-Picture API, including supported Chrome and
Firefox versions. The control is disabled when the API is unavailable or the
desktop is not connected. Browser permissions can still deny the request; check
those permissions and click the control again to retry. OpenClaw does not replace
unsupported PiP with an ordinary popup.

PiP mirrors the existing live connection without taking control or opening a
second desktop connection. Closing PiP leaves the original viewer and remote task
running. Disconnecting, changing the viewer's source or session, or closing the
originating viewer closes PiP; it does not stop the remote task. Keep the opener
tab open. A sleeping computer or a browser that suspends the entire page cannot
continue streaming.

## Quick open (local)

If the Gateway is running on the same computer, open [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/)).

If the page fails to load, start the Gateway first: `openclaw gateway`.

<Note>
On native Windows LAN binds, Windows Firewall or organization-managed Group Policy can still block the advertised LAN URL even when `127.0.0.1` works on the Gateway host. Run `openclaw gateway status --deep` on the Windows host; it reports likely-blocked ports, profile mismatches, and local firewall rules that policy may ignore.
</Note>

Auth is supplied during the WebSocket handshake via:

- the configured shared secret in either `connect.params.auth.token` or
  `connect.params.auth.password`; `gateway.auth.mode` selects the configured
  value (`gateway.auth.token` or `gateway.auth.password`)
- Tailscale Serve identity headers when `gateway.auth.allowTailscale: true`
- trusted-proxy identity headers when `gateway.auth.mode: "trusted-proxy"`

Gateway auth runs before device pairing. A direct loopback connection does not bypass token or password auth. The login screen and **Settings → Gateway** use one **Gateway secret** field: paste the token or type the password. After a successful connection, the UI keeps the secret in session storage for the current browser tab and Gateway origin only when the Gateway reports token auth. Passwords stay in memory and are never persisted. After pairing, the browser can use its stored per-device token on later connections.

When a plugin such as [MCP Relay](/plugins/mcp-relay) embeds the Control UI through [remote ingress](/plugins/sdk-gateway-ingress), its live grant admits the browser's signed device identity without a shared credential. Access is bound to the grant's principal and capped by its access limit. The browser stores no device token; every reconnect is admitted by the live grant again. Embedded pages stay connected to the serving Gateway, hide Gateway URL and shared-secret controls, and do not register a service worker. Connection failures remain visible in the app without a token/password login screen.

An embedder that supplies linked Gateways adds them to the identity menu's **Gateway** section. Select a Gateway to switch the embedded page, choose **Set as primary** when available, or open **Gateway settings…** in the host. The host owns the list, primary choice, and navigation. Native window actions, native Gateway keyboard shortcuts, and native reconnect actions are unavailable in embedded mode.

If you paste a setup code from **Devices → Pair device → Copy setup code** into **Gateway secret**, the UI shows an inline hint before you connect. Paste that code into **Settings → Gateway** in the OpenClaw mobile app. For the Control UI, run `openclaw gateway auth-token --show` in an interactive terminal on the Gateway host and paste the shared token instead. If a connection with a setup code is rejected for a token or password mismatch, the login screen repeats this guidance.

Local onboarding generates a Gateway secret in token mode by default, without a token/password picker, and preserves existing password mode. Use `--gateway-auth password` or `--gateway-password <value>` for explicit password setup; Tailscale Funnel requires password mode. If the Gateway starts in token mode without a configured token, it generates an ephemeral runtime token for that process instead. The runtime token is not written to config, so it cannot be recovered and a loopback browser without that token is rejected. Run `openclaw doctor --generate-gateway-token`, restart the Gateway, then run `openclaw gateway auth-token --show` in an interactive terminal and paste the output into **Gateway secret**. If Windows PowerShell reports that running scripts is disabled, start those commands through [npm's `openclaw.cmd`](/platforms/windows#powershell-execution-policy) instead of changing the execution policy.

<a id="agents-home" />

## Agents and Templates

Use the agent selector to open an agent's chat or its settings gear to configure
that agent. Per-agent settings remain at `/settings/agents/<id>`.

Open **Templates** in **Pages**, or visit `/templates`, to discover official Templates.
This page contains Templates discovery only. Enable **Templates** in **Settings → Labs**
to make it available; when disabled, both the Pages entry and direct visits to
Templates discovery or details are unavailable. The former `/agents` overview is removed.

To browse sessions across agents, choose the **Show all** tile in the agent
switcher. It appears with two or more agents and groups their own avatars: two
overlap diagonally, three or four form a two-column grid, and five or more show
three avatars plus a remaining-agent count. This enables **team mode**, a browser
preference that is off by default. The top row becomes a workspace header with
the configured Gateway display name, or **OpenClaw**, and a small static OpenClaw mark.
Both modes use the same selector: **Create new agent**, **Show all**, then compact
agent rows with a settings gear on the right. Choosing a gear opens that agent's
configuration without selecting it. The selected row has an avatar ring. Help
and its links remain in the account menu. Pinned sessions stay in **Pages**, using
their agent's avatar as the icon.
Other sessions appear under collapsible agent headers in configured roster order,
which stays stable as activity changes. **Home** disappears from Pages: click an agent header's avatar or name to
open that agent's main chat. The separate collapse control only folds its sessions.
The accented rail **+** below the workspace mark, labeled **New conversation**, opens the New session composer directly with your last-selected agent.
The selection is remembered in this browser for each Gateway; you can choose a
different agent inside the composer.
Each group's **+** opens a composer for that specific agent, appearing on hover or keyboard focus and remaining visible on touch devices. Selecting a session switches the active
agent for chat. Choose a named agent tile in the workspace menu to leave team
mode with that agent selected, restoring the agent chip and Home row.

Choosing **Show all** defaults the shared page scope to **All agents**. That scope,
including an explicit **All agents** selection, is saved in this browser for each
gateway. It survives reloads and switching to another gateway and back, even if
you open a different agent's chat in team mode. Choosing a named agent tile leaves
team mode and scopes pages to that agent. You can still choose a narrower page
scope while in team mode; navigating between pages does not reset that choice.
Automations, Dashboards, Sessions, and Usage support all-agent views, with
agent identity shown on mixed-agent rows. In Settings, choose an agent below the
sidebar title to keep the same target across Agents, Models, Memory, and Skills.
Global settings remain global. Skill Workshop uses the agent selected through
chat; open an agent's main chat from its group header to select it. Chat actions
always belong to the conversation's agent.

Choose **All sessions** from an agent group’s options menu to open the Sessions
page filtered to that agent. See [Sidebar navigation](/web/control-ui/sessions-and-sidebar#sidebar-navigation)
for group controls and filtering.

Agent names and avatars follow agent and identity updates. While a configured avatar image loads,
the avatar keeps its tinted background with no face or text. The image appears when ready;
an emoji or generated face appears only when no image is configured or the image fails to load.
Agents without an advertised image use their fallback without probing an avatar route.
Repeated views reuse prepared avatar thumbnails; updating the avatar refreshes its thumbnail.
Profiles with an uploaded photo or a linked email (for a Gateway-proxied Gravatar) request the
versioned profile image; profiles with neither use initials without probing an image route. Authenticated
misses for current profile revisions, agent avatars, and resolved workspace icons can remain in
the browser cache for up to one minute. New profile and agent image revisions use a new URL.
This behavior is shared by the roster, agent switcher, identity chips, settings, and chat.

Activity and previews in the sidebar roster refresh on session events
and Gateway reconnects. Reusing cached ancestry for the selected session does not
trigger another list read. Events collect in a randomized four-to-five-second window
that later events cannot postpone, spreading automatic reads across browsers.
After an automatic read, the next waits three times its duration,
bounded between five and 15 seconds. Navigation, reconnects, and explicit refreshes
bypass that delay. When both are visible, they share one activity window and
one refresh, so opening **Agents** while team mode is visible does not duplicate requests. Activity loading
stops when neither roster is visible. Team mode's owner and status filters reuse
this window instead of also loading a separate sidebar list; **Involving me**
still selects membership on the Gateway. Unchanged rows reuse the sidebar's
revision-based responses. Each refresh reads at most 300 sessions
across agents, loading pinned sessions first and then the most recent sessions.
Pinned sessions count toward that limit; sessions outside the window do not appear
in the grouped sidebar or contribute to activity summaries, except that the open
conversation remains visible so direct links keep a selected row. When a main session
is absent from the window, its agent's most recent session supplies the preview.

## What each page covers

- [Connect and pair](/web/control-ui/connect-and-pair) — pair a browser or phone, reach the UI over Tailscale, and fix a blank page.
- [Sessions and sidebar](/web/control-ui/sessions-and-sidebar) — sidebar zones, session menus, and the New session page.
- [Systems workspace](/web/control-ui/sessions-and-sidebar#systems-workspace) — contextual machine navigation and a desktop-first workspace.
- [Chat](/web/control-ui/chat) — composer controls, the session rail, transcript rendering, and hosted embeds.
- [Panels and docks](/web/control-ui/panels) — Ask OpenClaw, the Home dock, the operator terminal, and the browser panel.
- [Settings](/web/control-ui/settings) — identity, appearance, plugins, updates, MCP, activity, and meetings.
- [Feature and RPC reference](/web/control-ui/feature-reference) — every capability with the Gateway RPC behind it.
- [Offline and reconnect](/web/control-ui/offline-and-reconnect) — what survives a dropped connection.
- [Security model](/web/control-ui/security-model) — content security policy, media route auth, and approval links.
- [Build and develop](/web/control-ui/development) — build the UI and run the dev server against a Gateway.

Running the Gateway in Docker? See [Using the Control UI browser](/install/docker#using-the-control-ui-browser) for the browser-equipped image and setup requirements.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/web/control-ui#chat-behavior` still resolves. Each entry points at the page that now holds the content.

- <a id="session-rail-and-side-chat" />[Session rail and side chat](/web/control-ui/chat#session-rail-and-side-chat)
- <a id="session-links-in-messages" />[Session links in messages](/web/control-ui/chat#session-links-in-messages)
- <a id="composer-capability-menu" />[Composer capability menu](/web/control-ui/chat#composer-capability-menu)
- <a id="chat-behavior" />[Chat behavior](/web/control-ui/chat#chat-behavior)
- <a id="source-previews-and-copying-code" />[Source previews and copying code](/web/control-ui/chat#source-previews-and-copying-code)
- <a id="markdown-tables" />[Markdown tables](/web/control-ui/chat#markdown-tables)
- <a id="mermaid-diagrams" />[Mermaid diagrams](/web/control-ui/chat#mermaid-diagrams)
- <a id="hosted-embeds" />[Hosted embeds](/web/control-ui/chat#hosted-embeds)
- <a id="chat-transcript-layout" />[Chat transcript layout](/web/control-ui/chat#chat-transcript-layout)
- <a id="chat-message-width" />[Chat message width](/web/control-ui/chat#chat-message-width)
- <a id="send-and-history-semantics" />[send and history semantics](/web/control-ui/chat#send-and-history-semantics)
- <a id="talk-mode-browser-realtime" />[talk mode browser realtime](/web/control-ui/chat#talk-mode-browser-realtime)
- <a id="stop-and-abort" />[stop and abort](/web/control-ui/chat#stop-and-abort)
- <a id="abort-partial-retention" />[abort partial retention](/web/control-ui/chat#abort-partial-retention)
- <a id="strict" />[strict](/web/control-ui/chat#strict)
- <a id="scripts-default" />[scripts default](/web/control-ui/chat#scripts-default)
- <a id="trusted" />[trusted](/web/control-ui/chat#trusted)
- <a id="device-pairing-(first-connection)" />[device pairing (first connection)](</web/control-ui/connect-and-pair#device-pairing-(first-connection)>)
- <a id="pair-a-mobile-device" />[Pair a mobile device](/web/control-ui/connect-and-pair#pair-a-mobile-device)
- <a id="runtime-config-endpoint" />[Runtime config endpoint](/web/control-ui/connect-and-pair#runtime-config-endpoint)
- <a id="pwa-install-and-web-push" />[PWA install and web push](/web/control-ui/connect-and-pair#pwa-install-and-web-push)
- <a id="tailnet-access-(recommended)" />[tailnet access (recommended)](</web/control-ui/connect-and-pair#tailnet-access-(recommended)>)
- <a id="insecure-http" />[Insecure HTTP](/web/control-ui/connect-and-pair#insecure-http)
- <a id="blank-control-ui-page" />[Blank Control UI page](/web/control-ui/connect-and-pair#blank-control-ui-page)
- <a id="device-pairing-first-connection" />[Device pairing (first connection)](/web/control-ui/connect-and-pair#device-pairing-first-connection)
- <a id="tailnet-access-recommended" />[Tailnet access (recommended)](/web/control-ui/connect-and-pair#tailnet-access-recommended)
- <a id="list-pending-requests" />[list pending requests](/web/control-ui/connect-and-pair#list-pending-requests)
- <a id="approve-by-request-id" />[approve by request id](/web/control-ui/connect-and-pair#approve-by-request-id)
- <a id="open-mobile-pairing" />[open mobile pairing](/web/control-ui/connect-and-pair#open-mobile-pairing)
- <a id="connect-the-phone" />[connect the phone](/web/control-ui/connect-and-pair#connect-the-phone)
- <a id="confirm-the-connection" />[confirm the connection](/web/control-ui/connect-and-pair#confirm-the-connection)
- <a id="trusted-proxy-note" />[trusted proxy note](/web/control-ui/connect-and-pair#trusted-proxy-note)
- <a id="build-and-develop-the-ui" />[Build and develop the UI](/web/control-ui/development#build-and-develop-the-ui)
- <a id="debugging%2Ftesting%3A-dev-server-%2B-remote-gateway" />[debugging%2Ftesting%3A dev server %2B remote gateway](/web/control-ui/development#debugging%2Ftesting%3A-dev-server-%2B-remote-gateway)
- <a id="debugging/testing-dev-server-+-remote-gateway" />[debugging/testing dev server + remote gateway](/web/control-ui/development#debugging/testing-dev-server-+-remote-gateway)
- <a id="start-the-ui-dev-server" />[start the ui dev server](/web/control-ui/development#start-the-ui-dev-server)
- <a id="connect-the-remote-gateway" />[connect the remote gateway](/web/control-ui/development#connect-the-remote-gateway)
- <a id="origin-security-notes" />[origin security notes](/web/control-ui/development#origin-security-notes)
- <a id="feature-and-rpc-reference" />[Feature and RPC reference](/web/control-ui/feature-reference#feature-and-rpc-reference)
- <a id="chat-and-talk" />[chat and talk](/web/control-ui/feature-reference#chat-and-talk)
- <a id="channels-sessions-memory" />[channels sessions memory](/web/control-ui/feature-reference#channels-sessions-memory)
- <a id="cron-tasks-plugins-skills-devices-exec-approvals" />[cron plugins skills devices exec approvals](/web/control-ui/feature-reference#cron-tasks-plugins-skills-devices-exec-approvals)
- <a id="config" />[config](/web/control-ui/feature-reference#config)
- <a id="usage" />[usage](/web/control-ui/feature-reference#usage)
- <a id="debug-logs-update" />[debug logs update](/web/control-ui/feature-reference#debug-logs-update)
- <a id="automations-panel-notes" />[automations panel notes](/web/control-ui/feature-reference#automations-panel-notes)
- <a id="connection-loss-and-reconnect" />[Connection loss and reconnect](/web/control-ui/offline-and-reconnect#connection-loss-and-reconnect)
- <a id="openclaw-system-care" />[OpenClaw system care](/web/control-ui/panels#openclaw-system-care)
- <a id="home-dock" />[Home dock](/web/control-ui/panels#home-dock)
- <a id="operator-terminal" />[Operator terminal](/web/control-ui/panels#operator-terminal)
- <a id="browser-panel" />[Browser panel](/web/control-ui/panels#browser-panel)
- <a id="content-security-policy" />[Content security policy](/web/control-ui/security-model#content-security-policy)
- <a id="avatar-route-auth" />[Avatar route auth](/web/control-ui/security-model#avatar-route-auth)
- <a id="assistant-media-route-auth" />[Assistant media route auth](/web/control-ui/security-model#assistant-media-route-auth)
- <a id="approval-links" />[Approval links](/web/control-ui/security-model#approval-links)
- <a id="new-session-names" />[New session names](/web/control-ui/sessions-and-sidebar#new-session-names)
- <a id="new-session-preferences-and-recents" />[New-session preferences and recents](/web/control-ui/sessions-and-sidebar#new-session-preferences-and-recents)
- <a id="sidebar-navigation" />[Sidebar navigation](/web/control-ui/sessions-and-sidebar#sidebar-navigation)
- <a id="session-menu" />[Session menu](/web/control-ui/sessions-and-sidebar#session-menu)
- <a id="session-placement" />[Session placement](/web/control-ui/sessions-and-sidebar#session-placement)
- <a id="session-icons" />[Session icons](/web/control-ui/sessions-and-sidebar#session-icons)
- <a id="session-colors" />[Session colors](/web/control-ui/sessions-and-sidebar#session-colors)
- <a id="new-session-page" />[New session page](/web/control-ui/sessions-and-sidebar#new-session-page)
- <a id="start-a-native-coding-cli" />[Start a native coding CLI](/web/control-ui/sessions-and-sidebar#start-a-native-coding-cli)
- <a id="openclaw-chat-workspace-startup" />[OpenClaw Chat workspace startup](/web/control-ui/sessions-and-sidebar#openclaw-chat-workspace-startup)
- <a id="environment-identity" />[Environment identity](/web/control-ui/settings#environment-identity)
- <a id="community-invitation" />[Community invitation](/web/control-ui/settings#community-invitation)
- <a id="personal-identity" />[Personal identity](/web/control-ui/settings#personal-identity)
- <a id="gateway-host-status" />[Gateway host status](/web/control-ui/settings#gateway-host-status)
- <a id="language-support" />[Language support](/web/control-ui/settings#language-support)
- <a id="appearance-themes" />[Appearance themes](/web/control-ui/settings#appearance-themes)
- <a id="manage-plugins" />[Manage plugins](/web/control-ui/settings#manage-plugins)
- <a id="updates" />[Updates](/web/control-ui/settings#updates)
- <a id="apps-and-extensions" />[Apps and extensions](/web/control-ui/settings#apps-and-extensions)
- <a id="side-panel-keyboard-shortcuts" />[Side panel keyboard shortcuts](/web/control-ui/settings#side-panel-keyboard-shortcuts)
- <a id="this-mac-(macos-app)" />[This device (macOS and iOS apps)](/web/control-ui/settings#this-mac-macos-app)
- <a id="custom-plugin-ui" />[Custom plugin UI](/web/control-ui/settings#custom-plugin-ui)
- <a id="import-assistant-memory" />[Import assistant memory](/web/control-ui/settings#import-assistant-memory)
- <a id="mcp-page" />[MCP page](/web/control-ui/settings#mcp-page)
- <a id="activity-tab" />[Activity tab](/web/control-ui/settings#activity-tab)
- <a id="meetings-page" />[Meetings page](/web/control-ui/settings#meetings-page)
- <a id="this-mac-macos-app" />[This Mac (macOS app)](/web/control-ui/settings#this-mac-macos-app)

## Related

- [Dashboard](/web/dashboard) — gateway dashboard
- [Health Checks](/gateway/health) — gateway health monitoring
- [TUI](/web/tui) — terminal user interface
- [WebChat](/web/webchat) — browser-based chat interface
- [Codex session catalog and supervision](/plugins/codex-supervision) — the Native Session Discovery settings surface
