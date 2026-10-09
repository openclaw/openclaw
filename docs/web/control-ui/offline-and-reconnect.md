---
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

Agent names and avatars keep their last loaded values when an identity refresh
fails. Reads for the same agent share one request across the sidebar and chat,
including failures: subsequent reads back off from 500 ms to 5 seconds and honor
longer Gateway retry hints. Reconnecting clears the retry wait so identity reads
can resume on the new connection.

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
input. Retiring offline access does not discard unsent drafts or queued work;
that work remains under its original storage owner. Live state replaces cached
roster data on connect, and chat resumes from its saved transcript cursor. The
first chat request waits up to 300 ms for stored history before falling back to
a live read. Agent switches and stale asynchronous reads retain their own
identity checks. Agent pickers and the agent directory wait for a live roster;
stored agent lists cannot establish the current role’s discovery permissions. Short
conversation links use cached routing defaults and session rows before agent
discovery; the Gateway revalidates the established session after connecting.

Exact conversation links also wait for the scoped cached roster before presenting
their header. Dashboard layouts restore before the pane renders, and embedded
HTML widgets keep one loading surface while their board metadata and document
arrive. Widget requests still require the current Gateway connection.

Boot and roster records retain the existing 30-day expiry, and transcripts keep
their bounded cache limits. Clearing site data removes local recovery data.
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
sent. Existing attachment stores and storage limits remain unchanged. An older
UI cannot read the new account-qualified outbox keys; rolling back does not
convert that retained input back into an unowned queue.

## Offline page reload

Production builds prepare a generic offline shell and the critical Chat and New
Session interface files, plus the signed-out fallback, through the service worker.
Static asset preparation can use the browser’s existing same-origin proxy sign-in;
only integrity-matched build bytes with cacheable responses are admitted. After preparation
completes, a browser that explicitly reports itself offline can reload those
routes from the current build cache. Interrupted preparation resumes on the
existing startup/resume checks when the browser returns online, reusing verified
downloads instead of starting over. Preparation is bounded so a stalled download
cannot hold a UI update indefinitely. The existing warm-reload credential and
account checks still decide whether cached conversations may appear. No
Gateway-rendered private HTML, API responses, or authorization tickets are
added to this shell cache.

Reloads reuse cached build-versioned fonts, themes, and the web manifest without
contacting the Gateway. The service worker retains the current build and at most
two previous builds, so open tabs can still load their original assets. Uploaded
profile avatars use private browser caching only when the URL matches the image's
content revision; unversioned URLs and external avatar fallbacks still revalidate.
Content-addressed plugin interface assets stay in the private browser HTTP cache
across grant renewal; requests reaching the Gateway still require current plugin
authorization, and plugin data remains subject to per-call RPC authorization.

Online navigations still go directly to the network so reverse-proxy HTTP
authentication dialogs work normally. If the browser reports itself online
despite a broken connection, navigation keeps that network behavior. An open
tab remains the most reliable way to keep working through intermittent service.
Unvisited views and uncached external resources may still need a connection.

## Gateway updates and suspended tabs

An open tab checks the active UI build when it returns to the foreground, comes back online,
or is restored from browser history. If an update finished while the tab was suspended, it
can recover without receiving the original update notification or opening a new tab.

Automatic build-recovery reloads spread their first page check over up to two seconds
and reload only once per target build. Reloads wait for the page to be reachable
and respect unsaved-work protection.
The current route and stored drafts survive the reload. If browser storage is unavailable
or reload protection blocks recovery, reload the tab after saving your work;
do not clear site data while drafts or queued messages still need recovery.

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
state when the same Gateway connection temporarily drops. They do not need to
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

Once a session is established, a dropped Gateway connection does not log you out. The dashboard
stays visible, and one connection status in its sidebar footer explains whether the Gateway is
suspending, suspended, restarting, reconnecting, or finishing recovery. Planned transitions and
automatic reconnect use a calm presentation; authentication and other failures that need your
attention keep their explanation and recovery action. The same status appears in the macOS app's
embedded dashboard. Connection status does not replace the Gateway name in the account menu.

The client retries ordinary connection loss automatically with randomized backoff: the first
retry waits 800–960 ms, and sustained failures spread retries across 12.5–15 seconds.
Server retry hints remain minimum waits and can extend beyond that normal cap, with up to
20% additional spread. The connection watchdog allows two advertised heartbeat
intervals of silence before reconnecting. An individual request timeout does not
reset a socket that is still receiving traffic. Reconnecting does not replay
arbitrary requests; read owners retry their reads, and write owners reconcile
uncertain outcomes. Gateway startup hints keep their separate bounded timing
(100–2000 ms), with up to 20% additional spread across reconnecting tabs.
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
and account recovery, but an active run, an open queued-message edit, or uncertain previous
delivery can keep them waiting. **Inbox → System** shows local submissions that failed or
need delivery review, with **Review** opening their conversation and its existing recovery
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
Check the connection, then use **Reload**. The same error can occur after an update;
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

When the Gateway confirms that it holds the same pending input, the Control UI clears the
uncertain-delivery warning without sending the message again. The browser keeps its retry
payload until consumption or cancellation is confirmed. If delivery is still unknown,
the review warning remains.
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

If automatic restart recovery is interrupted or cancelled before the agent resumes,
the **System · restart recovery** notice shows that outcome and asks you to send a
message to continue. It does not mean the agent resumed. Messages forwarded from
other sessions keep their own delivery status next to each message.

Once the Gateway confirms that a message is in the transcript, reconnecting retires its temporary browser copy even when the original message is outside the latest history page. Loading older history shows the saved message in its original position without adding a second copy.

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
payload copies and marks those submissions **Delivery unconfirmed**. Check the conversation
before retrying. A duplicate first opened after the source discarded or delivered a message may
instead report missing attachments. Independent tabs do not share newly authored outbox messages.

After connecting, chat waits for account-scoped recovery before accepting or sending ordinary
messages. During this brief check, submitted text and attachments stay in the composer. Offline
queues resume once recovery is ready, unless the session still owns an unresolved initial turn;
resolve that turn with its **Retry** or **Check delivery** action first.
If the initial message is waiting for recovery, its chat shows a loading placeholder
until the message can be restored, rather than the empty new-chat welcome screen.
Recovery notices appear below the composer and clear when the blocking condition resolves.

If a sent message times out before its acknowledgement, the browser keeps it as
**Delivery unconfirmed**, not **Not sent**. It checks delivery receipts automatically
while the connection is available, without sending the message again. Timed-out
receipt reads retry with backoff; they do not release later queued messages ahead
of the uncertain input or overwrite a newer draft.

If the connection drops before a send is acknowledged, reconnect checks the transcript and
the session's active or last run ID for delivery proof. A matching run confirms receipt even
before its transcript row appears. Without proof, an attempted message stays in the conversation
with an amber **Delivery unconfirmed** footer, **Retry**, and **Discard**. Check the conversation and retry only
if the message did not arrive. Discard removes the pending copy from this browser's outbox; it does not
undo or cancel work the Gateway already accepted. Later queued messages stay paused until the earlier
unconfirmed message is resolved or discarded, and the queue explains that blockage. Discarding the
earlier message lets the next queued message proceed when the session is ready. Unconfirmed local
commands keep their retry/discard queue controls.

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
text or a local display copy is not proof. Any draft or other unconfirmed input in the row stays
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
