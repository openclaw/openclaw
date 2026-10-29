---
doc-schema-version: 1
summary: "What the Control UI keeps when the Gateway connection drops, and how it recovers"
read_when:
  - The Control UI shows Reconnecting or drops messages
  - Understanding what happens to queued input while offline
title: "Offline and reconnect"
sidebarTitle: "Offline and reconnect"
---

What survives a dropped connection, and how the Control UI recovers when it returns.

Returning to a suspended tab or regaining network connectivity can recover a
stale connection. These signals do not retry a connection that requires a page
reload, corrected credentials, or a new pairing request. Follow the displayed
recovery instructions; automatic document refresh remains available after an update.

While a visible tab is connecting or reconnecting, it checks same-origin Gateway
reachability at randomized intervals. A fresh response can resume a retry sooner
or replace an opening attempt stuck for at least eight seconds, even when airplane
Wi-Fi never reports an offline/online change. Young opening attempts and opened
sockets keep their normal handshake. Announced startup, restart, suspension, and
busy-Gateway waits keep their existing retry pacing; hidden tabs do not poll.
Expected reachability failures do not trigger sign-in recovery notifications.

An unanswered send starts a liveness check after about five seconds. Any inbound
frame proves the connection is alive; otherwise, ten more seconds without a
response moves the UI into reconnecting so queued input can recover. Idle
connections keep their longer heartbeat window.

If an update or rollback leaves a tab using an incompatible connection protocol,
the Control UI stops reconnecting and reloads the document served by the same
Gateway. The tab records the attempt in session storage: it reloads once for a
given server build and never more than once in 60 seconds, even if the build changes.
If the refreshed page still cannot connect, it keeps the compatibility error and
**Refresh** action visible. Open the Gateway's dashboard again or update and
restart the Gateway so its served UI matches its protocol. Automatic reloads wait
for unsaved-work protection and require working session storage; a separately
hosted UI must be refreshed or updated at its own host.

Agent names and avatars keep their last loaded values when an identity refresh
fails. Reads for the same agent share one request across the sidebar and chat,
including failures: subsequent reads back off from 500 ms to 5 seconds and honor
longer Gateway retry hints. Reconnecting clears the retry wait so identity reads
can resume on the new connection.

## Queued session changes

While the same Gateway connection is recovering, changes to a session's name,
icon, color, or existing category, archive/unarchive and delete actions, and
message reaction additions or removals appear immediately. Archived sessions move
out of the active list, unarchived sessions return, and deleted sessions disappear.
Archive and delete keep their confirmation dialogs while offline. Multi-select
archive and delete queue one change per selected session.
Deletion requires a known session identity. If it is unavailable, the UI shows an
error and asks you to refresh after reconnecting; other selected sessions still queue.
The connection status in the sidebar footer counts these
changes together with queued chat messages. Repeated changes to the same fields
or reaction replace the earlier queued change and move to the end of the queue,
so overlapping edits finish with the latest choice.
Archive, unarchive, and delete share one queued lifecycle change per session:
the latest choice wins without changing its place in line. A queued delete also
discards that session's unsent metadata and reaction changes and rolls back their
optimistic values.

These changes send in order after reconnecting with unchanged credentials and the
same account recovery scope, including Retry and automatic socket replacement.
New eligible session changes join the queue until its final request settles,
so older queued values cannot overwrite newer choices. The queued count includes
unsent changes, not the request already in flight.
The Gateway still checks current permissions and the
session identity. Rejected changes roll back and show an error; a delete whose
target is already gone succeeds. A change already
sent when the connection drops is not automatically replayed by this queue;
its existing uncertain-outcome handling still applies.

This session-change queue is memory-only. Closing or reloading the tab loses unsent
changes; the browser prompts before leaving, and automatic update reloads wait
while changes are queued. Switching Gateway or account, signing out, or retiring
offline access discards the queue and shows how many changes were discarded.
Chat drafts and chat messages retain their separate storage and recovery rules.

Other actions do not use this queue: creating categories, moving sessions between
projects or workspaces, shared pins, sharing or visibility changes, approvals, settings
or model changes, and terminal actions still need their existing live connection
and authority. Discovering and archiving a complete nested subtree also requires
a connection; offline archive targets only the selected rows. Workspace recovery
and removal of preserved worktrees are not queued.
Personal sidebar pins remain usable offline without this queue.

## Busy initial connection

If a WebSocket upgrade fails but the same-origin Gateway still answers its
`/healthz` liveness check, the sign-in screen shows **Gateway busy, retrying…**
with a countdown to the next automatic attempt. No click or credential change is
needed when capacity becomes available. This can happen when many visitors share
one venue IP and exhaust the [preauth connection budget](/gateway/security/rate-limiting#unauthenticated-websocket-connections).

The check sends no Gateway token and does not follow redirects. Unreachable or
unverified endpoints keep **Gateway unreachable** guidance; cross-origin Gateway
connections are not checked. Authentication and pairing rejections retain their
specific recovery instructions.

## Warm reload

After a successful sign-in, the browser can reopen its cached shell, sidebar,
conversation, and drafts while the Gateway is unreachable. Token and device-token
sign-ins retain their credential checks. Trusted-proxy, Tailscale, and password
sign-ins also support warm reload when the Gateway supplies a stable recovery
identity. A one-time bootstrap credential is never retained for offline admission;
a successful pairing can use the reusable device grant already issued and stored
by the browser client.

The cached agent roster supplies the conversation's agent name and text avatar
on the first render, including when the offline shell cannot fetch bootstrap
config. Reconnecting keeps the displayed identity until a live refresh replaces it.

The retained identity is for local display and storage, not permission to call
the Gateway. Reading, drafting, and queuing input remain available offline;
sending and synchronization wait for the Gateway to revalidate the account.
No password or new bearer credential is saved for this feature. Anyone with
access to the browser profile can access its locally retained data.

Ordinary network failures keep the admitted local shell visible while retries
continue. Authentication or pairing rejection retires cached admission instead
of silently restoring it after a later network error. **Forget this browser**
and explicit credential replacement also retire admission. A proxy sign-out
performed outside OpenClaw cannot be observed while disconnected; the Gateway's
next authentication result applies when contact resumes.

Transcripts, roster data, text drafts, and queued input are separated by Gateway
and account. Switching accounts cannot send or overwrite the previous account's
input. Changing identity or recovery scope, or retiring offline access, clears
active local pending copies with the existing discard notice. Persisted drafts
and queued input remain under their original storage owner; they are not
reassigned or sent under the replacement identity. Live state replaces cached
roster data on connect, and chat resumes from its saved transcript cursor. The
cached transcript opens at its latest messages without an initial scroll animation.
It retains participant and completed-work timing information and the last task
progress card for display while connecting; live Gateway results replace those
cached facts in place. Cached progress does not authorize offline actions. The
header also retains its last three viewer avatars and overflow count for that
conversation while connecting. The reconnect indicator describes connection
state; the full live presence roster replaces these last-known viewers when it
arrives. The identity-only hello does not clear them. The header retains the
sharing control's displayed mode and geometry while connecting, without enabling
its menu or membership actions until live authority is available.

The cached window also retains resolved link labels, image dimensions, archive
attribution, and avatar source identities. Previously displayed inline thumbnails
can paint with their rows while reconnecting, without a new network read. These
display copies do not authorize opening originals or other Gateway actions.

Thumbnail storage shares the transcript's Gateway and account scope. It holds at
most 32 thumbnails and 8 MiB total, with a 256 KiB limit per image; animated and
full-size originals are excluded. Display facts cover up to eight links and eight
images per retained row, across 80 rows. Thumbnails leave the cache with their
rows, and scope retirement, session reset, or forgetting the browser clears the
affected copies. Missing, evicted, or incompatible data keeps the usual loader.
Media tickets and credentials are never added to these display facts.

The first chat request uses the saved cursor if the cached transcript is ready when
the live message subscription finishes connecting. Otherwise, the live read and
cache restoration run in parallel. Agent switches and stale asynchronous reads
retain their own identity checks. When the cached conversation also has the exact
pending-input page and session metadata, the Gateway confirms unchanged fields
with receipts instead of sending them again. Changed or consumed inputs still
refresh their display, and a missing cache or expired transcript cursor fetches
complete state. These receipts do not grant access; the Gateway checks the current
session and account before confirming any retained data.

Agent pickers and the agent directory wait for a live roster;
stored agent lists cannot establish the current role’s discovery permissions. Short
conversation links use cached routing defaults and session rows before agent
discovery; the Gateway revalidates the established session after connecting.
Unique display-name links use the same cached route resolution, including the
`/dashboard` namespace. Missing or ambiguous names still wait for the Gateway.

Exact conversation links can restore their scoped transcript without waiting for
the sidebar roster or the socket to open. A prepared snapshot supplies the header,
transcript, and composer in the first pane frame. The existing header connection
indicator remains visible until live history and route confirmation finish; cached
content stays visible while those checks run. Dashboard layouts restore before the pane renders, and embedded
HTML widgets restore their last board metadata from the same scoped conversation
cache and start loading the isolated sandbox while connecting. Document requests
still require the current Gateway connection and overlap the live board refresh.
Unchanged widgets keep their iframe; changed, removed, or forbidden boards replace
or clear the cached view. Pending or rejected MCP apps wait for live board data.

Loading more sessions keeps the sidebar's warm-reload snapshot usable. The
routing roster retains its first page; the sidebar separately keeps its visible
rows, pinned destinations, and selected view for display while connecting. The
Pages view saves and restores its dashboard catalog without waiting for the
inactive Sessions roster.

Boot and roster records retain the existing 30-day expiry, and transcripts keep
up to 80 recent rows (plus rows from the same history entry) for a warm reload.
The snapshot also retains the slash-command catalog and its revision. Warm
startup reuses that list when the Gateway confirms it is unchanged; config,
plugin, and skill changes refresh it through the existing metadata owner.
Saved dashboards restore independently of transcript validation, so a slow
transcript download does not delay their layout. The Gateway still revalidates
the board, its grants, and document tickets on connection.
Older history loads from the Gateway as you scroll up. Cache upgrades discard
older, unbounded transcript records; a connected visit fills the new cache.
The first upward scroll or **Show earlier** refills the Gateway's current history
window before continuing to older pages. Automatic viewport filling does not
trigger this refill. Overlapping cached rows are deduplicated.
Clearing site data removes local recovery data.
If browser storage is unavailable or no usable record exists, the connection
screen appears as usual.

Approval, question, and focus documents do not read or publish the workspace’s
warm state. An independent sign-in attempt cannot delete another tab’s valid
admission merely because its credentials differ or its pairing link is rejected.
Retirement remains scoped to the admitted owner; an actual account replacement,
**Forget this browser**, or clearing site data still retires the affected admission.

### Upgrading existing browser data

The account-scoped transcript cache replaces older unscoped derived snapshots;
those old transcripts are discarded rather than attributed to the next account.
A connected visit fills the new cache. Existing unowned drafts and queued input
are preserved for explicit recovery and review, not automatically assigned or
sent. Draft and queued-input attachment stores keep their existing storage limits;
warm transcript thumbnails use the separate bounds above. An older
UI cannot read the new account-qualified outbox keys; rolling back does not
convert that retained input back into an unowned queue.

## Offline page reload

Production builds prepare a generic offline shell and the critical Chat and New
Session interface files, plus the signed-out fallback, through the service worker.
Static asset preparation can use the browser’s existing same-origin proxy sign-in;
only integrity-matched build bytes with cacheable responses are admitted. After preparation
completes, a failed navigation to a built-in app route can use the cached shell,
including when the browser still reports itself online. Network navigation waits
up to 10 seconds before falling back; HTTP authentication responses are not replaced.
Interrupted preparation resumes on the
existing startup/resume checks when the browser returns online, reusing verified
downloads instead of starting over. Preparation is bounded so a stalled download
cannot hold a UI update indefinitely. The existing warm-reload credential and
account checks still decide whether cached conversations may appear. No
Gateway-rendered private HTML, API responses, or authorization tickets are
added to this shell cache.

Once the shell is ready and the browser is online and idle, the service worker
downloads the remaining built-in JavaScript and styles in the background. After
this first download, offline-capable menus and actions can open even if you have
not used them since the update. This includes the interface code for drafts,
queued chat sends, session changes, and reactions; each action keeps its existing
connection and authorization requirements. Downloading the interface does not
make live-only actions or uncached conversation data available offline.

Each update downloads only missing or changed files. Background downloads yield
to page requests, check file integrity, and retain completed files if interrupted;
startup and resume checks can continue the download. Save-Data and slow-2g/2g
connections skip this background download and record the reason in the service
worker console. The critical shell still prepares normally, and files opened
online still cache on use. Connection-speed and Save-Data changes automatically
recheck the background download policy. English interface code is included; other language
catalogs, the isolated Mermaid diagram renderer, and plugin-hosted assets are
excluded from the background inventory and keep their existing loading behavior.

Reloads reuse cached build-versioned fonts, themes, and the web manifest without
contacting the Gateway. The service worker keeps the current complete build and
one complete previous generation, so older open documents can still load their
cached chunks. An incomplete replacement does not discard the last complete shell.
Unchanged files referenced by the new inventory are retained before older caches
are removed, so an update does not need to download those files again.
After an update, open tabs reload automatically unless unsaved-work protection
blocks recovery; then save or discard the protected work and use the **Reload**
banner. Uploaded profile avatars use private browser caching only when the URL
matches the image's content revision; unversioned URLs and external avatar
fallbacks still revalidate.
Content-addressed plugin interface assets stay in the private browser HTTP cache
across grant renewal; requests reaching the Gateway still require current plugin
authorization, and plugin data remains subject to per-call RPC authorization.

Navigations try the network first. API, download, and standalone
authentication paths do not receive the offline shell. Plugin catalog detail
links under `/plugins/` remain network-dependent because that namespace also
hosts plugin HTTP endpoints. An open tab remains the
most reliable way to keep working through intermittent service.
Until the background download finishes, unvisited views may still need a
connection. Excluded optional assets and uncached external resources may also
need a connection.

## Gateway updates and suspended tabs

An open tab checks the active UI build when it returns to the foreground, comes back online,
or is restored from browser history. If an update finished while the tab was suspended, it
can recover without receiving the original update notification or opening a new tab.

Automatic build-recovery reloads spread their first page check over up to two seconds
and reload at most once per target build every 30 seconds. Reloads wait for the page to be reachable
and respect unsaved-work protection.
The current route and stored drafts survive the reload. If browser storage is unavailable
or reload protection blocks recovery, reload the tab after saving your work;
do not clear site data while drafts or queued messages still need recovery.
Unsent highlighted-text comments in Side chat also restore after a Gateway restart
or page reload, including their quoted text and source anchors. They use the same
Gateway- and account-scoped browser draft storage, not shared session history.
Editing or removing a comment updates that saved draft; sending the Side chat
question or clearing Side chat retires its unsent comments. Incognito comments
remain memory-only. Clearing browser site data removes saved comments too.
While a Side chat comment autosave is pending, the composer shows **Saving…**.
Automatic and in-app reloads are blocked, and a browser reload or close warns
before discarding that unsaved input. Wait for saving to finish before refreshing;
a forced exit can still discard a write that has not committed. Storage failures
keep the comment available in memory with the existing browser-storage warning.

If a view or stylesheet download fails during a network interruption, the open
page keeps checking reachability with a backoff capped at 15 seconds. Coming
back online or returning to the tab wakes that check early. Once the document
is reachable, a cold route retries its import without replacing the page. The
previous page stays visible while the route is pending. A persistent import
failure can still require a guarded reload because browsers can retain failed
module downloads. Failed Vite CSS preloads also require guarded recovery to avoid
opening a view without its styles. Optional font and theme stylesheet failures do not trigger
document recovery. Unsaved-work protection still applies, and the manual
**Reload** action remains available.

During startup, slow app downloads keep the **Control UI is still loading**
notice without interrupting the download. After the document finishes loading,
the app gets another 12 seconds to render before recovery starts. If the
Gateway is unreachable, startup recovery keeps probing with a backoff capped
at 15 seconds. It allows up to three automatic recovery navigations; if fresh
pages still cannot start, use **Try again** or the troubleshooting guide.
Network failures and **Try again** preserve service-worker registrations and
their offline caches.

Unsaved file edits block automatic and in-app reloads, even after you close their
previews or switch conversations. Reopen each edited file and save or discard its
changes, then retry the reload. If a server update makes the editor unavailable,
choose **Review file drafts** in the reload notification. You can copy or download
each retained draft without connecting to the Gateway, explicitly discard resolved
drafts, then try **Refresh** again. **Keep drafts** leaves them protected in this tab.
Each draft shows the session title, session key, and pane position captured when
the file was opened, so matching filenames remain distinguishable. Newer edits
remain protected if they change while you review an older draft.
File edits stay in memory in the current page;
an explicit browser reload or closing the browser tab discards them.

## Visualizations during a connection loss

Already-rendered inline visualizations keep their iframe and local interaction
state when the connection to the same Gateway and account temporarily drops,
including wake recovery and **Retry now**. They do not need to
download their contents again just to remain visible. On reconnect, the client
revalidates the document; changed content or a changed account, Gateway, or
authorization scope replaces the old view. Server-dependent widget actions
remain unavailable until their current authority is established.

Slow widget loads show a waiting notice after 10 seconds without immediately
canceling the work. Their 30-second hard deadline and paced transient retries
allow recovery without repeatedly presenting terminal errors. Definitive access
failures and script errors still show actionable feedback. External widget
resources are not made available offline by retaining the iframe, and a full
page reload does not persist a widget’s unsaved local interaction state.

## Connection loss and reconnect

An open Control UI keeps its last accepted Gateway capabilities through a temporary
disconnect. Navigation, plugin tabs, attachment limits, and the displayed Gateway
version do not disappear simply because the socket closes. Pages remain interactive
for reading, copying, filtering, and local drafting; actions that require a live
Gateway remain unavailable. Some pages still reload their own data on reconnect,
and unvisited views or external resources may need a connection.

Retained capabilities describe the current client identity; they do not authorize
requests. A new handshake replaces them. Replacing the client or credentials,
stopping the connection, authentication or pairing rejection, and protocol/build
rejection clear that presentation. Canvas capability URLs retain their separate
live-connection lease and are not kept by this policy.

Model Providers, Plugins, Devices, Skills, Profile, Channels, Cloud Workers,
GitHub connection editors, and Session Storage keep loaded data
and unsaved in-memory drafts through a temporary loss of the same Gateway
connection. Editors stay open; actions that require the Gateway remain unavailable
until it is connected. Reconnect refreshes the loaded data without
discarding your edits. Switching identities or losing access still clears the
affected settings. These drafts are not persisted by this behavior: reloading
or closing the tab can discard them, including entered credentials.

Plugin Settings panels, including the Memory overview and memory search, stay open
through the same kind of reconnect. Search results, the typed query, and opened
memory files remain visible; searching waits for the connection, and replies to
requests sent before the drop are discarded. Reopening a file whose read was
interrupted retries it. Changing the Settings agent, account, or access starts a
fresh panel.

Rejected model-default saves return the pickers to the saved configuration.
**Retry** keeps the rejected change with the configuration write owner. Model
edits that have not been sent still survive a temporary disconnect. After
reconnecting, defaults remain unavailable until the current configuration loads;
a failed read does not present the previous connection's defaults as current.

Unsent configuration form edits resume autosave after reconnect only when a
fresh read confirms that their base revision is unchanged. If a submission was
in flight or the revision changed, autosave stays paused for explicit recovery.
Raw configuration edits remain manual-save-only. Reconnect does not replay
plugin installations, setup answers, or other arbitrary actions.

Once a session is established, a dropped Gateway connection does not log you out. The dashboard
stays visible. The sidebar avatar has a green connection dot when healthy, amber during recovery
or suspension, and red when disconnected or a refresh is required. The sidebar footer
explains the interruption without moving the page and briefly shows **Connected** after recovery.
With the sidebar collapsed, a flag beside the avatar appears for four seconds on status changes.
Hover or focus the avatar to reopen it. If the flag would cover a composer or other writing
controls, the avatar tooltip carries the status instead. The tooltip is hidden while the flag is visible.
On mobile, status replaces the header breadcrumb and badges the menu button; opening the drawer
shows the full footer row. Brief disconnects keep the existing two-second grace.

The status includes the total queued messages and session changes, plus **Retry** when an immediate connection
attempt is available. Hover or focus for the redacted connection error. Settings keeps its save feedback
visible alongside connection status. One persistent shell region announces connection changes,
even while the mobile drawer is closed. Native embedded views keep their own connection
chrome, including the status in the embedded Settings header. Connection status does not replace
the Gateway name in the account menu.

The client retries ordinary connection loss automatically with randomized backoff: the first
retry waits 800–960 ms, and sustained failures spread retries across 12.5–15 seconds.
Server retry hints remain minimum waits and can extend beyond that normal cap, with up to
20% additional spread. The Gateway's WebSocket ping/pong keepalive detects dead
peers on the server, but browsers cannot observe those frames or receive a close
over a silently dead link. A connected, visible tab checks inbound silence every
five seconds. After two advertised heartbeat intervals (60 seconds by default),
or 15 seconds after the first request sent since the last inbound frame, it sends
one read-only `health` request without active integration probing. Sent requests
still count after they time out; any inbound event or response resets that clock.
It reconnects only if no event or response
arrives during the next 10 seconds. A locally closed socket is retired immediately;
recovery does not wait for an unreachable peer to finish the WebSocket closing handshake.
Any inbound traffic proves the link is alive;
a responsive but busy Gateway is not reconnected just because application ticks
are delayed. Hidden tabs do not probe; returning to a suspended tab uses the
existing wake recovery after two advertised heartbeat intervals of silence.
An individual request timeout does not reset a socket that is receiving traffic.
Reconnecting does not replay
arbitrary requests; read owners retry their reads, and write owners reconcile
uncertain outcomes. Gateway startup hints keep their separate bounded timing
(100–2000 ms), with up to 20% additional spread across reconnecting tabs.
If a dropped connection interrupts a Usage export, the export shows an error. Once
the connection returns, choose **Export** again; exports are not replayed automatically.
If the browser provides no reason for the disconnect, the connection tooltip explains that
the connection was interrupted and whether automatic reconnection is underway. It retains
the WebSocket close code for troubleshooting; specific Gateway errors keep their explanation.
Open the account menu and use **Retry now** to request an immediate attempt when offered.
Sign-in failures use the sign-in flow, and a required dashboard refresh uses its reload flow;
retrying the connection does not replace either action. Live updates and realtime/session actions pause until the connection
returns. Chat remains editable without a pre-queue helper. The conversation-specific outbox
summary appears only after a message is queued, alongside the actual queued message.

Ordinary text and attachment sends require successful admission to the current tab's
Gateway/session-scoped browser outbox. Eligible messages resume automatically after connection
and account recovery, but an active run or an open queued-message edit can keep
new sends waiting. **Inbox → System** shows local submissions that failed or
need recovery, with **Review** opening their conversation and its existing recovery
controls. Ordinary queued messages stay in the chat queue; they do not raise Inbox attention.
The account and connection indicators describe identity and connectivity, not message delivery.
The composer count covers only its conversation and does not promise automatic sending.
Draft text and saved messages awaiting destination recovery are separate.

While a connected chat finishes account recovery, Send stays unavailable and
explains that recovery is pending. Your draft stays in the composer. Once recovery
finishes, ordinary messages can enter the queue even if chat history is still loading.
Stop and approval controls keep their existing availability.

These Inbox entries are a read-only view of the current account’s browser-tab/Gateway outbox,
not a new server-side or cross-device inbox. They show available conversation labels, not message text,
attachment names, or private error details. Review does not retry or discard anything, and
entries cannot be dismissed independently of their pending copy. Local review remains available
while disconnected; server-dependent Inbox actions remain unavailable. Return from Settings
to the workspace to open Inbox.
If storage fails, the composer keeps the unsent input and shows recovery guidance.

Controls that need a live connection stay unavailable while offline. **Stop** can queue an exact
local run ID for replay. A session-only stop is not replayed because newer work may start in that
session before the connection returns.

Queued messages follow the order shown in the queue, including moves made while
attachment bytes are loading after reconnect. A message already being sent keeps its place.
If another pane is editing a message, finish or cancel that edit before moving
messages across it. A successful retry clears that edit-conflict notice.
Opening a queued-message editor after the other pane releases its edit clears the earlier
edit-conflict notice.

Editing an unsent queued message remains safe if the connection drops mid-edit.
Confirming text with an input method keeps the queued-message editor open;
press Enter again after composition finishes to save the edit.
Open queued-message edits stay available when you switch conversations, even after
visiting enough chats to replace older cached views. Finish or cancel the edit to
release that retained conversation.
An open queued-message edit also blocks automatic UI reloads after a Gateway update.
Use **Review edit** in the reload notice to return to its conversation and split,
even after switching to another page.
Save or cancel the edit, then use **Refresh for full capabilities** to continue.
Explicit browser reloads do not preserve an unsaved queued-message correction.
If another pane changes or removes that message, the edit stays open: copy your
correction, cancel the edit, and review the queue before trying again. A full queue
asks you to wait or remove a message. If browser storage prevents saving an edit,
keep the tab open and copy the correction before freeing storage. A successful
save clears the previous error.

Page and sidebar refreshes that fail because the Gateway is suspending, restarting, starting,
or unreachable show no inline error: the footer connection indicator owns that state. Each panel
keeps its last data and refreshes automatically once the Gateway accepts work again.
Agent pickers and the agent directory clear their roster while reconnecting and
wait for a fresh authorized list, including when the same user's role has changed.
Established conversation names remain visible in the browser tab and chat headings,
including split views, while reconnecting to the same Gateway and account. Other refresh
failures remain visible inline with their message and are retried automatically when the Gateway
becomes available again. These refresh callouts have no manual **Retry** button.

When an Agent identity save is interrupted, its editor leaves the saving state on
reconnect. If the same agent remains selected, the draft stays available to review
and save again; a late result from the interrupted request cannot clear a newer edit.

After reconnect, an open conversation link is checked against the Gateway. If the
Gateway confirms that the conversation no longer exists, such as an incognito
conversation after a Gateway restart, the page shows **Session not found** with
actions to open Main or browse sessions. A connection failure or a conversation
missing from the current sidebar page does not count as deletion.

Opening a view for the first time can fail if its interface files cannot be downloaded.
The UI waits for reachability and reloads automatically, subject to reload protection
and the 30-second loop guard. You can also use **Reload**. The same error can occur after an update;
it does not by itself mean a new version was installed. If unsaved work blocks the
reload, follow the displayed save or cancel guidance, then try again.

A delayed history refresh preserves any newer run and its live output. A fresh idle
response can clear a stale busy indicator after the run finishes.

Transient history and live-subscription reads retry with backoff while their
conversation and connection remain current. The bottom-left connection indicator
shows **Restoring…** while an open conversation recovers. No extra recovery notice
appears above the chat; the cached transcript and draft remain available.
Each history attempt has a 30-second deadline within the existing 60-second
consumer recovery window. Subscription acquisition retries only after its
previous observer has been safely reconciled. If recovery remains unsuccessful,
one history notice offers **Retry**, which reloads the conversation and restores
its live subscription, including approval updates. Permission and other terminal
failures remain visible rather than being silently retried.

After a graceful Gateway restart, each marked running root conversation receives
one standard resume input. Accepted user messages captured in that shutdown's
marker follow it in FIFO order, even while this browser is closed. Each sender must still
have current authority; an unavailable or revoked sender gets an ordinary failed
send that can be resent. New input uses normal steering and queue rules while the
resumed run works.

A crash or forced kill does not resume work automatically. Stored conversations
remain available for a new message. At startup, accepted queued input without a
live owner or graceful-restart marker becomes a cancelled send with its text intact,
so you can review and resend it. It does not count as pending work. Legacy interrupted
input remains inert. The browser preserves submission IDs when reconciling uncertain sends.

When the Gateway acknowledges a send, including a duplicate submission, the
Control UI marks it sent. The browser keeps any payload needed to display
server-held input until consumption or cancellation is confirmed.
Confirmed server custody does not block later browser-queued
chat sends.
Local commands such as `/compact` and `/reset` in the same browser outbox wait
for live accepted work. Legacy interrupted input without a live owner is inert and does not block later commands. An independent
authorized reset from another client can cancel pending work, as with other session resets.
If the Gateway is holding that input for a later turn, it appears in the queue
above the composer. Removing that row withdraws the exact queued message without
stopping the active turn. Once cancellation is confirmed, the removed prompt and
its attachments disappear from the queue and conversation, including after a
reconnect or reload. Server-held messages cannot be edited or reordered.
If the message has already started, Remove leaves the active run alone; use Stop
to interrupt it.
Stopping a turn or an unsuccessful send can still leave a cancelled prompt with
recovery guidance; those actions do not remove the prompt.
Incognito chats keep their existing cancellation behavior: Remove cancels queued
work, but the cancelled-message notice remains until the private session ends.

Acknowledging a duplicate submission retires its pending browser copy even when
the original message is outside the latest history page. Reconnect does not need
to scan old history to establish delivery. Loading older history shows the saved
message in its original position without adding a second copy.

Retiring a delivered attachment does not discard the run's completion. If the browser misses
that completion, a queue recovery read that confirms the same session and run have finished
clears the stale running indicator and resumes queued input.

Queued attachments use binary Blobs in the browser's IndexedDB; the outbox keeps only delivery
metadata and payload references in session storage. Attachment bytes stay with the queued input;
the captured queue metadata owns its destination, even when configured main-session defaults change. All attachments
must be stored before the message is admitted, and all must be readable before sending. Failed admission leaves the draft
unsent. Missing or unreadable queued payloads leave a visible row with recovery guidance; the
browser never sends just the remaining attachments. Binary outbox storage requires browser
storage access. On plain HTTP, each page load uses a fresh payload owner because Web Locks are
unavailable; reloads and duplicated tabs copy payloads before sending and leave the old bounded
payload for browser-storage cleanup. Gateway attachment limits still apply.

The outbox retains up to 25 MiB of attachments per message and 250 MiB across this browser origin,
subject to the browser's own quota. Queued payloads have no age-based expiry. Delivery or discard
releases them; closing a tab or interrupting a tab copy or cleanup can leave orphaned payloads
within that bound. If capacity remains
full after sending or discarding your queues, save any needed drafts before clearing this site's
browser storage. That also clears browser-local drafts and sign-in state. Outbox queues belong to
the browser tab; they are distinct from restart-recoverable composer drafts. Incognito sessions
keep their existing tab-only inline outbox and its smaller browser storage limit; they never
store queued attachment Blobs in IndexedDB.

Duplicating a tab copies the same submission IDs. Once opened, the duplicate claims its own
payload copies and resumes pending sends with their original IDs after account
recovery. The Gateway recognizes recorded submissions instead of starting them again.
A duplicate first opened after the source discarded or delivered a message may
instead report missing attachments. Independent tabs do not share newly authored outbox messages.

After connecting, chat waits for account-scoped recovery before accepting or sending ordinary
messages. During this brief check, submitted text and attachments stay in the composer. Offline
queues resume once recovery is ready, unless the session still owns an unresolved initial turn;
that first message also retries automatically with its original submission ID.
An explicit rejection keeps **Retry** available. While disconnected, a
notice above the composer says the initial message is unresolved; the composer still accepts
queued messages.
If the initial message is waiting for recovery, its chat shows a loading placeholder
until the message can be restored, rather than the empty new-chat welcome screen.
Recovery notices appear below the composer and clear when the blocking condition resolves.

Until the Gateway acknowledges a chat send, it stays pending, including when
the frame was written but its acknowledgment times out or the socket closes.
If the connection stays healthy, an acknowledgment timeout or retryable rejection
automatically retries the same submission, honoring the Gateway's retry delay.
This also applies to the first message and memory-only sends.
While disconnected, it shows **Waiting for reconnect**. On the first accepted
connection with the same identity and recovery scope, the browser resends
attempted pending messages in queue order, preserving each original `runId` and
`idempotencyKey` and their original conversation identity. Replacing or deleting
the conversation cannot redirect the retained input. A stored attempt without
its original conversation identity stays in **Needs review** until an explicit
Retry binds it to the conversation you are viewing.
An acknowledgment or duplicate response marks the message sent;
it does not mean the agent has finished its reply.

The Gateway checks the recorded submission before dispatch. A matching user
transcript row or durable input receipt prevents another turn or transcript
append, including after the in-memory deduplication cache expires or the Gateway
restarts. This also covers attachments, commands sent through `chat.send`, and
per-message overrides. Reusing a recorded key with different content is rejected.
The guarantee applies while that submission record remains in the same session;
it does not restore deleted sessions or resume interrupted agent work.
Queued input captured in the graceful-shutdown marker follows the session's resume
input under each sender's current authority. A crash does not trigger queued-input
reconstruction; later graceful restarts do not adopt those older rows.

**Discard** stays available while a message is pending. It removes only this
browser's outbox copy, not work the Gateway already accepted. It does not undo or
cancel a delivered message. Local commands that use other RPC methods retain
their own recovery behavior; reconnect does not blindly replay arbitrary actions.

An ordinary message rejected by the Gateway stays in the conversation with a **Not sent**
footer. Use **Retry** to try again or **Discard** to remove its pending browser copy.
Discard stays effective after reloading the tab; it does not cancel Gateway work or
remove messages already in the conversation history.

If the Gateway reports that a `/steer` or `/redirect` message failed to start, the Control UI
restores the submitted draft when the composer is still empty. It preserves newer text, replies,
and attachments. If you switched conversations, recovery stays with the original conversation.
If you moved Home between the page and its dock while the command was pending, recovery
follows the current Home composer and preserves any newer draft entered there.

Queued messages and drafts keep the conversation and agent selected when they were created.
Switching agents, opening a split pane, or reloading does not move them to another destination.
When split panes show the same conversation, returning to an older pane after visiting other
conversations does not replace a newer saved draft. Text, selected recipients, quoted replies,
Goal mode, and attachments follow the same draft revision. A selected reply survives reload
with its preview and original message target, even before you enter text. Canceling the reply
clears that selection without discarding the text. Sending transfers the reply to the submitted
message; a failed admission restores it only if you have not started a newer draft. Switching quickly between split panes keeps
the last selected conversation active, including when narrowing the window.
A literal `global` conversation keeps its captured agent; an agent's main conversation stays
separate unless the Gateway is configured with global session scope.

Older browser state may have combined several destinations into one bucket. The Control UI uses
metadata version 4 (`openclaw.control.chatComposer.v4:`), migrating version 1, 2, and 3 records
directly when their destination is still identifiable. It verifies the new metadata before
removing an older source, retaining complete sources when storage or recovery capacity blocks
migration. This metadata change does not change the IndexedDB schema or durable-draft keys. Saved
input awaiting review appears as compact **Unsent** or **Draft** rows directly above the composer.
Open the intended non-Incognito conversation with an empty composer and queue, choose **Restore**,
and confirm the displayed conversation. **Delete** asks before removing a saved copy. Recovered queued messages stay paused: check for
previous delivery before using **Retry**. Recovered attachment drafts return to the composer
without sending. Reconnect, a replacement session, or enabling Incognito while confirmation is
open cancels the transfer; confirm again in the intended conversation. Older attachment drafts
whose destination is known stay cleared when that destination has a newer clear. Ambiguous saved
data remains available for review. Queued Blob references and original submission IDs survive
both automatic migration and explicit destination recovery. Credential-bound messages are shown
only under their original Gateway credential scope, including when an older bucket contains
messages from several scopes. Moving a message into or out of recovery does not delete its bytes;
cleanup follows verified delivery or discard and accounts for retained recovery messages too.
When the original conversation's loaded history proves a saved queued submission was delivered,
its recovery copy is removed automatically. Proof requires the exact submission ID on a durable
user message in the same conversation and, when recorded, the same physical session. Matching
text or a local display copy is not proof. Any draft or other unresolved input in the row stays
available; recovery never sends a message automatically.
If the destination changes, a newer draft appears, or storage fails, recovery keeps the source
available rather than overwriting newer input. Do not clear browser site data
while you still have saved messages or attachment drafts to recover.

If the browser closes its draft database connection, the next storage operation
opens a fresh connection automatically. Recovery storage errors appear above the composer;
they do not mean that messages have lost their destinations or that browser storage is full. Reload to retry if
the error persists, keeping site data intact.

First opens and reloads without usable warm state show a small animated OpenClaw mark while the Gateway resolves the initial
connection, including when authentication comes from a trusted proxy or Tailscale instead of a
browser-stored credential. The login gate appears only after the initial connection fails or the
Gateway actively rejects authentication (bad token/password, missing trusted identity, revoked
pairing). Transient connection failures retry automatically; authentication failures explain
what needs your input.

## Reloading a session link

Authenticated app documents carry the same presentation and capability config as
`control-ui-config.json`, so the first render can use the configured assistant
identity without waiting for the WebSocket. These documents use private, no-store
caching. Public and unauthenticated documents carry no protected bootstrap data;
the app starts its config request alongside connection startup. Reconnects and
configuration-change events refresh the serving Gateway's config.
