---
summary: "Sidebar zones, session menus, and the New session page"
read_when:
  - Finding, grouping, or renaming sessions
  - Sharing a session with teammates or through a public read-only link
  - Starting a session on a device, worktree, or cloud profile
  - Starting a native Codex or Claude Code terminal
title: "Sessions and sidebar"
sidebarTitle: "Sessions and sidebar"
---

The sidebar organizes every session, and the New session page starts new ones.

## New session names

In **New session**, pausing typing for one second prepares a session name in the
background using only the selected agent's utility model. Preparation sends unsent
draft text to that provider before submission. It starts after at least 12 characters
and sends at most the first 1,000 characters; it does not send attachments.

Preparation is disabled in incognito and for slash commands. Edits replace stale
prepared names, and only one request runs at a time. A missing or failed utility model
does not fall back to the primary model or prevent you from starting the session.

An explicit personal account selection waits for account confirmation before
preparing a title. A utility model on the same provider uses that account unless
the utility model specifies its own auth profile. Changing the model or account
discards the old suggestion; neither action changes your saved account default.
With **Automatic**, title preparation uses the agent's utility-model auth, which
can differ from the personal default selected when the actual chat starts.

**Start session** uses a matching prepared name if it is ready. Otherwise, normal
initial naming runs after submission; Start never waits for the speculative call.
This is creation-only: later messages do not regenerate an existing session's
name. Explicit worktree names are preserved, and typing never creates a worktree
or runs setup.

If automatic naming fails after submission, the session receives a two-word,
crustacean-themed name. New worktree branches use the saved session title when
available, with the same two-word fallback if naming has not finished. They never
use the first-message text as a branch-name fallback. A title that arrives later
updates the sidebar without renaming an existing branch.

## New-session preferences and recents

In **Project → Browse**, keyboard focus moves to the folder path. Escape returns
focus to **Browse**. Loading and folder errors are announced without moving focus
away from the path field.

For connections with a durable user profile, the Gateway stores each agent's latest folder, worktree, model, thinking, and fast-mode choices. New sessions restore the last fast-mode choice, including an explicit off choice, for supported providers. The new-session picker also shows recent projects and folders derived only from sessions created by that profile. These conveniences follow the person across browsers; they do not grant access to a project or path.

A custom worktree **Name** applies to the submitted session. Once its start is
accepted, New session clears that name while remembering the repository, checkout
mode, and base branch. Background starts do the same. Failed admission leaves the
name available to retry; an accepted placement keeps its original session and
worktree request for recovery, even if workspace preparation later fails. If
clearing the saved name cannot be confirmed, the UI warns you to check Name
before starting another worktree; the accepted session continues. Cleanup preserves
newer checkout choices saved by another draft or browser, and keeps concurrent
model changes. A restored start whose original base choice cannot be distinguished
from a later edit also leaves the saved name unchanged and shows that warning.
If saving a new draft choice cannot be confirmed, a separate warning asks you to
check the choices before starting; session creation is never retried by preference cleanup.

On the first identified connection, the Control UI uploads existing browser-local new-session preferences only when the Gateway has no such preferences yet. Concurrent first connections preserve choices already saved by another browser, including a cleared worktree name. Later changes write to the Gateway first and then update the browser mirror. Connections without a durable identity continue using browser-local preferences and the loaded session roster for recents.

When a remote project session starts before its repository finishes cloning, chat shows workspace preparation progress. If preparation fails, opening or reloading chat restores the session's failure summary. Correct the reported problem, then send a new message in the same session to retry preparation.

Accepted browser messages, including initial prompts waiting for workspace
preparation and follow-ups during a run, remain visible as normal message bubbles
until their own turn starts, without an additional receipt notice. Inputs accepted through `sessions_send` or the
Gateway `agent` method use the same display. They are stored separately from the active model transcript. If
cancellation or a Gateway restart interrupts that wait,
the message stays readable with its recorded disposition and is never resent
automatically. Stopped messages stay at their original time in the conversation,
before messages sent later; only inputs still waiting to run stay at the live edge.
Copy a stopped message into the composer to start a new attempt. **Show earlier
messages** pages through messages that are still waiting or were stopped before
processing; **Show latest messages** returns to the newest page. Incoming activity
refreshes the page you are reading without changing your selection. A long message
uses the normal full-message reader without becoming a transcript reply, fork,
or rewind target.

Browser drafts and unsent messages remain in the local queue. Once the Gateway
accepts an ordinary browser message, it owns the approved input in durable
custody. Collect mode consumes the accepted sources with their combined
transcript entry. Acceptance does not imply that a transcript row already
exists; the accepted input replaces its local pending copy and later becomes
one canonical message, including its attachments.
Messages keep their queue position through submission, acceptance, reconnects, and
storage recovery. Changing delivery status does not reorder them; explicit queue
reordering and steering retain their normal behavior.

## Systems workspace

Open **Systems** in the sidebar, or visit `/systems`, to inspect the Gateway,
worker environments, and paired devices available to your connection. If your
customized sidebar does not include Systems, add it from **Edit pinned items**.

Systems replaces the conversation list with a machine list below the global
navigation. Navigation and the active list share one scroll area on every route;
the sidebar header and footer stay fixed. Returning to conversations restores
their sidebar scroll position. Navigation changes this context; background
machine or session activity does not switch your workspace.

Use **Filter & sort machines** beside the search field to sort each group
alphabetically, online first (the default), or offline first. Choose **All**,
**Online**, or **Offline** to filter by reported status; search narrows that
selection further. Starting, stopping, and error states remain visible under
**All**. Filtering does not change the machine open in the workspace. These
choices stay in place when you leave Systems and return on the same connection.

The machine list excludes cloud workers whose teardown is complete, including
retained records from archived sessions and failed starts with no allocated
machine. Workers awaiting cleanup remain visible. Archiving stops running cloud
workers through the normal workspace-reconciliation flow; failed placements keep
their existing cleanup retries and recovery history.

Select a desktop-capable system to open the existing Desktop viewer in the main
workspace. It uses the same connection, control, sizing, and fullscreen behavior
as the Desktop panel. Headless and offline entries remain inspectable instead
of opening an empty desktop. Pairing, desktop enablement, and operator permissions
still apply; opening Systems does not grant additional access.

System details use reported facts. A connected device is not necessarily the
machine running a session, and unavailable measurements are not shown as zero.
See [Cloud Worker Desktop](/gateway/cloud-workers/desktop) for worker desktop
enablement and sizing.

## Sidebar navigation

Drag page destinations, including plugin-provided pages, to reorder them together.
The order is saved in your sidebar preferences and survives reloads. A temporarily
unavailable plugin keeps its saved position for when it returns. **Home** stays
at the top in chip mode. Plugin links shown by default can be reordered but not
dragged out of Pages to unpin them; optional plugin destinations can still be unpinned.

To reorder without dragging, focus or hover a page, pinned session, or stored
session-section header and open its **Reorder** grip menu. Choose **Move up** or
**Move down**; the same menu is available on touch screens. Keyboard focus stays
with the moved item, and the order uses the same saved preferences or Gateway
group order as dragging. Home and sections derived from people, projects, or
agents keep their existing fixed order.

To inspect Home’s subagents, open **Home**, choose **Show background tasks**, and use the right-hand **Tasks** panel. Expand **Finished** for recent completed runs; selecting a task opens its details and available transcript.

Follow-up turns in an existing subagent session keep the parent’s activity ring running, even after the original task has finished. Opening the parent refreshes its hidden subagent activity without adding subagent rows to the sidebar. The ring clears when no work remains active.

Hover a session to see its project and branch. Repository details and the working directory stay in the hovercard and tooltip, leaving sidebar rows clear for session titles and activity indicators.

Hover a session with an enabled automation and choose **Automation attached** to open its **Automations** page. A single matching automation opens directly in the editor; multiple matches appear in a session-filtered list. You can inspect settings and history or edit with the usual permissions. **Show all automations** clears the session filter. Cmd/Ctrl-click opens the link in a new browser tab.

In the default chip mode, the sidebar organizes everything around the active agent. The identity row at the top is that agent; below it, the **Pages** section starts with **Home** — the agent's rolling main session, badged with its unread or running state — followed by the pinned destinations (**Automations** and **Plugins** by default). The customize control on the Pages header opens a menu with every other destination, including **Usage** and plugin-provided tabs, plus **Edit pinned items**; right-clicking the navigation area opens the pin editor directly. The session list below splits into zones: **Other** for the agent's ungrouped chat sessions (the main session appears only as Home, including when it is pinned or has subagents; independent conversations it spawned appear here as top-level threads, and named threads show without a type prefix), **Groups** for group and room conversations, and **Coding** for sessions bound to a managed worktree or exec node (rows show a `repo ⎇ branch` line plus the node host), ACP-backed harness sessions, and external CLI catalogs. The **Other** heading is omitted when it is the only section. Coding starts collapsed on first run and remembers your choice; its collapsed header keeps the true count and shows a running indicator while contained sessions work. Custom groups (the session `category`) and **Pinned** rows sit above Other, and assigning an independent session to a custom group wins over the automatic zone classification. The global **Sessions** toolbar holds the filter and sort control (Created, Last updated, or Owners when the loaded session roster contains multiple owners), **Group by** — **Custom groups** (the default zone layout above), **Project** to bucket sessions by their repo or workspace checkout (sessions without one keep their zones), **Person** to bucket by owner when the loaded roster has several, or **None** for a single flat list with no zone headers — a persisted **Status** filter for Active, Archived, or All, and the **+** that opens the New session page. The Owners sort mode orders owner groups by name and keeps Created order within each group. On multi-user gateways the same menu adds an **Owners** filter: **All owners**, one specific person or agent, or **Involving me** — sessions you own, have prompted, or have been explicitly mentioned in, excluding sessions you personally hid with **Hide from Involving me**. A new explicit mention brings a hidden session back. **Show in Involving me** restores it from **All owners**. The personal Hide/Show menu entry appears only when the Gateway has more than one identity. These personal choices do not archive sessions or alter access, and the Gateway evaluates the filter before pagination (see [Multi-user mode](/concepts/multi-user#finding-sessions-by-owner)). Archived rows stay inline, dimmed with an archive glyph; they do not contribute unread or attention state and stay outside lineage promotion. Opening a session moves the selection highlight without reordering rows. Parents with nested persistent sessions or forks show a disclosure and child count; expand it to inspect those sessions, their status, and runtime without leaving the sidebar. Selecting a nested session opens its chat and reveals its ancestor path. If a persistent session has subagent runs between it and its nearest loaded non-subagent ancestor, it nests under that ancestor. If no such ancestor is loaded, it keeps its normal top-level placement. These child rows stay outside root grouping, pinning, dragging, multi-select, and pagination; collapsed zones do not consume the visible page budget. Subagent runs never appear as sidebar rows, even when selected or assigned a custom group, and do not add a disclosure to a parent with no nested persistent sessions. Inspect them through inline transcript activity rows, the chat **Tasks** tab, or the [Tasks page](/automation/tasks#control-ui). Sessions with new activity since they were last read show an unread dot, and opening one marks it read. Accepted work immediately shows an activity ring around the row’s own icon for Home, sessions, child sessions, and catalog rows; a row without an icon shows a compact ring in the icon slot. Subagent runs still contribute to their ancestors’ running, queued, and failed counts, unread attention, and failure warnings. A session’s ring stays active while its subagents work. When only delegated work is executing, the ring is labeled **Subagents working**. Select an ancestor’s child-failure warning to inspect the failed run in chat without adding a sidebar row. Collapsed groups and collapsed child toggles summarize hidden running rows on the right. It spins during startup and execution, pauses with **Queued** only during a scheduler-confirmed concurrency-slot wait, and resumes when a slot is granted. With reduced motion enabled, the ring stays still. A session holding composer text you typed but never sent shows a pencil badge until the draft is sent or cleared; the active session hides it because its composer is already in view. An agent can also publish a short expiring status line and optionally request attention with a curated amber icon; that declaration clears when you open the session, send the next message, clear it explicitly, or its TTL expires. Cloud-worker lifecycle states use a globe badge; local and reclaimed sessions omit a placement badge because local execution is the default. Each session row offers a direct **Archive** button alongside **Pin**; archived rows offer **Restore**. Right-click a row, or focus its link and press **Shift+F10** or the **Menu** key, to open the full [session menu](#session-menu). Touch layouts keep Pin, Archive, and a separate menu button visible so every action remains available without right-click. The chat header also provides the session menu. The chat header composes the same single-session management actions with its pane-specific **Panels**, **Layout**, and **View** actions. Cmd/Ctrl-click opens a session in a new browser tab. Alt/Option-click toggles root rows into a multi-select and Shift-click extends it across the visible order; opening the menu on a selected row then offers batch actions (Mark N as unread/read, Move N to group, Archive N, Delete N) that apply to every selected session, with a single confirmation for batch delete. Drag a root session onto **Pinned** to pin it, or onto a custom group to move it. Custom group headers can be collapsed, expanded, or dragged to reorder them; group names, order, and New Session defaults live in the gateway (`sessions.groups.*`), so they follow you across browsers, while collapsed state stays in the browser profile. Each custom group header has a **+** that opens the normal New Session page and assigns the created session to that group. When the **Other** header is visible, its **+** opens an ungrouped draft without inheriting the current named group. **New session defaults** in the group menu sets its working directory and Local or Worktree preference; the page prefills those values but leaves them editable. Leaving the directory empty uses the selected agent's workspace. A Git repository without an initial commit can use Current checkout; creating a Worktree requires an initial commit. The menu also has Rename group, New group, and Delete group; renaming or deleting a group updates every member session server-side, including archived ones, and deleting a group keeps its sessions and moves them back to Other.

Choose **Show all agents** in the agent switcher to enter **team mode**, which shows every selectable agent as a collapsible session group. It is off by default, and the browser remembers your choice and each agent's collapsed state. Groups start expanded. Headers emphasize the agent's avatar and name. Activity, attention, unread, and workspace indicators sit on the right of session rows; collapsed parents and agents summarize hidden work and outcomes there. A row shows each status once, even when both the parent and a hidden child share that status. Session icons stay to the left of their titles in both sidebar modes; status indicators and actions stay on the right. Nested children indent 16px per level without moving the right edge of the trailing indicators. Groups keep the configured agent order as activity changes. Agent headers are 48px tall with 36px avatars; session rows stay on one line at 32px on desktop. Each agent header is its Home entry: selecting the name or avatar opens the main conversation and highlights the header. Home does not appear again as a session row, even when pinned. The header shows Home activity, unread state, and attention while expanded, and summarizes the group's hidden sessions while collapsed. Independent conversations created from Home remain visible beneath the agent.

Session-row owner avatars appear automatically when the signed-in user and session roster identify more than one human. With only one human, owner avatars stay hidden even when agents own or participate in sessions. Agent participants and undisplayed participant counts do not enable attribution. Session icons, channel avatars, and activity indicators keep their usual behavior.

Observer assessments such as **stuck** or **waiting on user** stay with their session instead of opening a global toast over another conversation. This does not change explicit questions, approval requests, action feedback such as **Archive → Undo**, or completion notices for sessions you explicitly start in the background.

Pending questions and approvals show their specific request when you tap, hover, or keyboard-focus the attention icon. Tapping the icon keeps the sidebar open; tap again or press Escape to dismiss the preview. The tooltip includes the oldest question, compact command, or approval title, plus a count of additional questions or approvals. This works in the regular list, Home, and team mode, including collapsed parents and agent groups. Questions and approvals take priority over agent attention notes and failed runs; requests at the same priority show the oldest first. Answering, approving, cancelling, or expiry clears that request and reveals the next one. Previews wrap and truncate without adding another line to session rows. Secret questions show only the question text, never entered answers.

The top row becomes a neutral workspace header with the configured Gateway display name, or **OpenClaw**, and the OpenClaw mark. Its menu contains **Show one agent**, **Agent settings**, and the documentation, help, community, and changelog links. Choose **Show one agent** to restore the agent chip and its full switcher menu. The sidebar header toolbar contains collapse, search, session filters, and **+** controls.

Agent avatars use the same precedence throughout the dashboard: an identity image (a data or same-origin URL), then the identity emoji, then a generated face. The face is stable for the agent ID, including after a rename, and uses crisp vector artwork in the sidebar, switcher, New conversation menu, Agents home, identity chips, and chat. Configured workspace images also appear beside assistant replies after authenticated loading. A missing or failed image reveals the emoji or generated face. System agents always use the OpenClaw product mark, including in onboarding and custodian conversations; they never use a generated face. People keep their own profile images and initials.

In team mode, **Home** is hidden from Pages. Click a group header's avatar or name to open that agent's canonical main chat; its separate expand/collapse control folds the group without navigating. The top **+**, labeled **New conversation**, opens a small agent menu with each agent's avatar and name, in the same order as the groups. Choosing an agent opens `/new?agent=<id>`. Each group's **+** opens that link directly. It appears when the header is hovered or contains keyboard focus, and stays available on touch devices. Turning team mode off restores chip mode, including its Home row and direct **New conversation** button.

Enabling team mode changes the shared page scope to **All agents** and remembers the previous scope. Turning it off restores that scope. This sets a default once when the mode changes: you can select an individual agent afterward, and page navigation preserves your choice. Automations, Dashboards, Sessions, Tasks, and Usage support all-agent views. Mixed-agent lists identify the agent on each row with an avatar and name where needed. Each identity chip includes the agent ID in its tooltip and screen-reader label, such as `Molty (agent:main)`, so agents with the same display name remain distinguishable. If no name is available, the label uses `agent:<id>`. In Settings, the agent selector below the sidebar title keeps the same target across Agents, Models, Memory, and Skills; global settings remain global. Skill Workshop uses the agent selected through chat. Open an agent's main chat from its group header to select it for Skill Workshop. Chat actions still target the conversation's agent.

Each group contains the agent's pinned and recent sessions, with the usual session menus, unread badges, nested child sessions, section limits, and **Show more** controls. Selecting any session switches the active agent for chat while the workspace header keeps its neutral identity. The **Sessions** filters apply across all agent groups, and the human **Online** section starts collapsed in team mode; expand it to see who is online. Category, person, and project grouping controls remain in chip mode; team mode always groups by agent and keeps empty agent groups visible. The open conversation keeps its selected row, including an archived conversation opened directly under the default **Active** filter. The filter button in the sidebar header keeps the same session filters. Each agent header has a **New conversation** action and an options menu with **Open main chat**, **All sessions**, and **Collapse others**. **All sessions** opens the Sessions page and sets the shared agent filter to that agent. When a collapsed agent needs attention, its icon stays visible beside the header actions on hover, keyboard focus, and touch devices. Counts and quiet summaries yield that space to actions on hover or keyboard focus; touch devices keep those actions visible. Session rows reserve space only for present indicators, so quiet titles can use the full row width.

Groups share a window of at most 300 sessions across agents with [Agents home](/web/control-ui#agents-home), loading pinned sessions first and then the most recent sessions. Pinned sessions count toward that limit, so more than 300 pinned sessions cannot all appear in this view. The open conversation can remain visible outside this window. **Involving me** loads the same bounded window filtered by the Gateway; the other filters apply to the loaded sessions across groups.

The active session list applies Gateway lifecycle row snapshots to existing members without reloading the whole list. Membership changes, missing or incomplete row snapshots, and Gateway-owned filters still require an authoritative list read. Automatic roster refreshes collect events in a fixed five-second window that later events cannot postpone. After an automatic refresh completes, the next waits three times its duration, bounded between five and 15 seconds. Explicit refreshes, filter or agent changes, reconnects, and foreground replacements bypass that delay.

Activity refreshes pause while the browser tab is hidden and catch up once when you return, respecting the automatic refresh delay. Changes that arrive during a roster read share one follow-up refresh; switching filters never combines pages from different filters.

The **Online** list opens a person's activity card with their reported device,
platform, and connection type: **Web**, **App**, **Terminal** for the TUI, or
**Command line**. Renaming a device does not change its connection type. Duplicate
device and platform labels are combined. Architecture labels such as **ARM** appear only
when explicitly reported; a browser's `MacIntel` value does not identify an Intel
CPU because Apple silicon Macs and desktop-mode iPads also report it.

Toggle the sidebar with **⌘B** on Mac or **Ctrl+B** on Windows/Linux. Open the command palette with **⌘K** on Mac or **Ctrl+K** on Windows/Linux. Mac **Ctrl+B** and **Ctrl+K** remain available for native text editing.

The search field updates immediately, while command filtering and session searches wait until you pause typing for 200 ms. Previous results stay in place during that pause but cannot be selected until the new query applies. Press Enter to apply a pending query immediately and select an available matching result. Clearing the field restores the default commands immediately.

During text composition, the command palette pauses searches and leaves Enter, Escape, and arrow keys to the input method.

After token or device-token authentication, the sidebar can show its cached session roster on reload only when the browser will present the Gateway token that authenticated the previous connection, or the paired device token retained from that connection. The cached roster has no live run state and is replaced by the live list after connecting. Other authentication methods wait for the connection; see [Warm reload](/web/control-ui/offline-and-reconnect#warm-reload).

Switching agents refreshes the session list even while other conversations are active. A session action finishing for another agent keeps the selected agent’s filtered sidebar and pagination active. Confirmed permission, pin, and read changes remain visible if their follow-up list refresh fails. Older responses cannot undo confirmed pin or read state; newer activity or a later manual unread mark still takes effect.

**Load more sessions** stays disabled while the sidebar list is refreshing or loading another page. It becomes available again when the read finishes and more sessions remain.

An older list response preserves newer session names and run status already loaded in another open session list.

Loaded persistent child-session rows stay visible while an expanded or selected parent fetches updated child data after a session-list refresh. Child loads preserve newer names and run status already observed in other session lists. A selected child also adopts its refreshed name and run status as soon as its details arrive, including while its ancestors are still loading. Its ancestor path refreshes when the session is replaced or its parent changes, including in filtered lists. Collapsed, unselected parents drop stale child snapshots on refresh and reload when reopened; the selected session's ancestry stays available. A loading placeholder appears only when the parent has no loaded child rows yet. Child-load errors remain visible until you choose **Retry** or collapse and reopen the parent.

**Archived** hides active sessions even when their conversation remains open. In **Active**, a directly opened archived session can retain its selected row. Archiving a visible session hides its row immediately while keeping its conversation open. Repeated archive actions stay disabled while the Gateway confirms the request. Confirmation offers **Undo**, including when you leave the Sessions page before the archive finishes or navigate away from the archived chat while the notification remains visible. Undo targets the original conversation and expires on a Gateway reconnect. If the request fails, the row returns with an error explaining what prevented archiving. Confirmed archive, restore, and pin changes remain applied to loaded rows if the follow-up refresh fails. If archiving already removed a row from every loaded list, Undo needs a successful refresh to show it again. The refresh error is shown separately; it does not undo a successful archive or restore. Refresh the session list to recover missing rows.

Session previews are hidden by default for compact, single-line rows. Enable **Show message preview** in the **Sessions** filter menu to restore routine status text and message previews. The browser remembers your choice. Errors and requests for attention remain visible with previews off. Team mode keeps all session rows on one line. Three fixed slots on the right show the collapsed child count, unread state (a dot for one, a count for more), and activity or attention. Requests for input and errors take priority over activity in the state slot; expand a parent or group to inspect each conversation. Collapsed agent groups use the same slots. Nested expand controls are plain carets in the left gutter.

**Hide empty groups** in the same menu shows your current choice and opens three options:

- **When filtering** (default): hide native session sections with no matching sessions while a specific owner or **Involving me** is selected.
- **Always**: also hide empty native sections in the unfiltered view.
- **Never**: keep empty groups available while filtering. Sessions still obey the active filters.

This is a personal display preference, stored in this browser separately for each signed-in user and Gateway. It does not change another person’s view, group membership, order, or session access, and it is not synced across devices. Connections without an identified user keep a separate browser-only choice. An existing on/off browser choice is adopted once by the first resolved viewer: on becomes **Always**, while off becomes **When filtering**. Later viewers do not inherit that migrated choice.

Changing or clearing a filter never changes the saved preference. Populated groups stay visible even when collapsed, and hidden custom groups remain available in **Move to group**. Choose **Never** to recover their headers as drag targets. Catalog sections and empty agent groups in team mode retain their existing behavior. On narrow screens, the three choices open in the same menu with a **Back** action instead of a flyout.

Native CLI catalogs appear only when they contain sessions matching the current owner filter. Empty catalogs stay hidden even when discovery fails or the CLI can start new sessions. Catalogs load on connection. When the Gateway advertises catalog change events, catalogs refresh on those events with paced bursts and a ten-minute safety refresh. Otherwise, visible tabs refresh catalogs every 30 seconds. Returning to a hidden tab also refreshes its catalog. If more pages remain, discovery follows their cursors until a matching session appears, the catalog is exhausted, or a host reports an error, without repeating the first-page request. Discovery preserves its progress and pauses while the browser tab is hidden. A later refresh checks the first page for new sessions and restarts completed empty scans so older sessions that become visible are still discovered. Expanded catalogs preserve their loaded pages across refreshes. Populated catalogs remain visible when another host fails, with discovery details in their status indicator. Hidden catalogs do not keep the **Other** heading visible when it is the only remaining section. Native CLI starts remain available from **New session**.

**Mark as unread** creates a reminder that remains unread while the current chat stays open, including while a run streams or completes. Leave and reopen the session, or choose **Mark as read**, to clear it.

Opening a session as a viewer leaves its unread marker intact, including shared sessions. Draft sessions acknowledge reads automatically only for their owner or an administrator. If the Gateway rejects an automatic read acknowledgement because of invalid session state or missing access, the UI reports the error once for that unread episode and waits for a new episode or for you to reopen the session. Temporary failures can retry on a later session update. Manual unread reminders still remain until you reopen the session or choose **Mark as read**.

**Delete** removes the confirmed selection from loaded session lists immediately and leaves any deleted conversation that is open. The Gateway finishes deletion in the background, safely stopping and reclaiming an attached cloud worker first. If deletion fails, the affected session can reappear with an error; other successful deletions and any navigation you made in the meantime are preserved. Browser drafts are retired only after deletion is confirmed, not while the request is pending.

On the Sessions page, checkbox selections survive paging through the loaded list.
When the list refreshes, sessions that have disappeared, left the current filter,
or been replaced are deselected. A replacement never inherits the old session's
selection. Bulk deletion remains bound to the sessions you selected, including
while its confirmation dialog is open.

**Rename** in the sidebar, chat header, and Sessions page starts with your custom name or the generated dashboard title. Edit the text, then save or press Enter. Saving an unchanged generated title leaves automatic naming intact; clearing a custom name restores the generated title. Channel and account decorations stay outside the editable name. Rename targets the session you started editing. If that session is deleted and recreated at the same key before you save, the edit is rejected instead of renaming the replacement. Reopen Rename on the current session to try again. Resetting the conversation keeps the same session identity and does not invalidate the edit.

**New group** from the sidebar, chat header, or Sessions page keeps the original session selection while the dialog is open and the group is being saved. A deleted or replaced session is not moved; an error is shown and the new group remains available. For a sidebar multi-selection, sessions that still exist can move even if another target fails. Paging a selected session out of the visible list does not cancel its move.

Your saved custom name always takes precedence over an automatic title, even if
it resembles an Android device label such as `OpenClaw App · Phone · abc123`.
Older device labels saved as custom names keep that precedence until you clear
or replace them explicitly. New Android device labels are stored separately, so
a generated conversation title can replace the device label without changing
your custom name.

### Session menu

Root sessions and ordinary Home-linked dashboard sessions can be pinned. Spawned and nested-child sessions reject pin requests, including when they appear as top-level threads. Subagent runs also reject pin requests and remain outside sidebar navigation.

An ordinary conversation's **Actions** menu also offers **Move to group**, even
when its header links back to Home. That breadcrumb does not make the
conversation a nested child.

Pinned parents keep their indented child trees and vertical guides in the Pages section. Expanding or collapsing a pinned parent shows or hides its children together.

The menu groups routine actions first: **Pin/Unpin**, **Rename**, **Mark as unread/read**, and **Archive/Unarchive**. **Delete** stays separate at the bottom.

- **Icon & color** opens one picker with color swatches, an icon grid, and **Reset to default**. It stays open while you change both; the sidebar reflects your changes.
- **Move to group** includes **New group** and **Remove from group**. Multi-user gateways also offer **Assign to** ([session ownership](/concepts/multi-user#assigning-an-owner)).
- **Fork conversation** creates a separate conversation; while a run is active, it forks from the last completed message. Forks of local folder and project sessions keep that workspace, so existing file references continue to open. **Fork from here** keeps the same local workspace as well.
- **Copy** offers a session link, conversation text as Markdown, and the session ID. The link requires normal Gateway authentication and session access; copying it does not grant access. Markdown loads the available conversation history, not just the messages currently visible. Both copied Markdown and `/export` downloads retain the conversation's sender labels, so messages from different participants remain distinguishable.
- In the Control UI, `/export` and `/export-session` download Markdown through your browser and take no file path. An argument leaves the draft intact and shows how to retry. The server-side HTML export available through other clients keeps its separate workspace-path behavior.
- The chat header's **Session sharing** control manages authenticated teammate visibility and membership. For a saved, non-incognito session, its creator or a Gateway admin can also enable world-readable, read-only public access.
- **Open in** offers a new browser tab or window. Desktop chat also offers **Split right** and **Split below**. Eligible local workspaces expose native editor destinations, and the chat header includes **Continue in terminal** in this submenu.

### Share a session publicly

1. Open the saved session and select **Session sharing** in the chat header. In the compact header menu, select **Session sharing** there instead.
2. Under **Public access**, select **Enable public access…**, review the warning, then select **Make public**.
3. Select **Copy public link**. The **Public** badge in the chat header remains visible while the transcript is published.
4. Open the copied URL in a signed-out browser to verify that it shows the intended conversation text. New user messages and assistant final answers become visible there automatically.
5. Return to **Session sharing** and select **Disable public access** when the link should stop working. The same URL then returns an unavailable page; disabling access cannot recall copies that recipients already saved.

The public page excludes tools, reasoning, files, images, widgets, hidden messages,
and internal metadata. Credential-pattern redaction is best effort, so review the
conversation itself before publishing. Public access does not let visitors send
messages or open the authenticated Control UI. For token lifecycle, pagination,
backup behavior, and login-proxy configuration, see
[Public session transcripts](/web/urls#public-session-transcripts).

### Session placement

Hover a cloud session in the sidebar to see its provider and profile. When known, a compact line below them shows the operating system, machine class, vCPU count, and memory in GB. The placement badge tooltip includes the same machine details; unavailable fields are omitted.

A selected session running on a worker shows a quiet **Runs on Cloud** chip in the chat header. Connections with `operator.write` can choose **Move session…** to continue on the Gateway or an eligible paired device, and can use **Stop cloud worker…** through the write-scoped `sessions.reclaim` lifecycle. Moving to a configured cloud profile requires `operator.admin`. Cloud rows are filtered against all execution modes advertised by each profile: the same bundled Crabbox profile is selectable for OpenClaw `worker-turn` and Codex `remote-exec`, while a genuinely single-mode profile stays disabled for the other runtime. Profiles with multiple machine classes show a machine picker. Leaving the Move session picker untouched omits a size override; explicitly selecting a class, including the displayed default, sends that class. Choosing a different class on the current profile resizes the session. The confirmation explains that an active turn is interrupted and never replayed; OpenClaw reconciles the workspace before activating the destination. While the durable operation is in progress, the chip shows **Moving to…**. If recovery is blocked, the chip exposes the bounded error after reconnect so the action never fails silently.

You can send a message while an existing worker session is provisioning or preparing its workspace. The accepted message shows **Received · waiting for worker setup** and starts automatically once that worker is ready. Stop, Move, and Restart keep their own admission controls; cancelled or interrupted input is not silently started on a different destination. The unsent draft in the New Session flow remains separate from accepted input.

During the initial handoff, the chat placement menu and stop confirmation use the selected destination: **Stop device worker…** for explicit or automatic paired-device placement, **Stop cloud worker…** for a cloud profile, or neutral **Stop worker…** when the target is unknown; all use `sessions.reclaim`. A destination retained for retry after a failed startup does not label a later restart.

### Session icons

Choose **Icon & color** from a single session's context menu to give its sidebar row a persistent emoji, monochrome icon, or custom SVG. The picker includes common emoji and six named icons: `braces`, `book`, `monitor`, `bot`, `kanban`, and `coins`. Choose **Custom icon…** to enter a single emoji, paste SVG markup, or paste an SVG data URL (percent encoded or base64). SVGs must be self-contained and at most 16 KiB decoded; scripts, embedded documents, and external references are rejected. Include `xmlns="http://www.w3.org/2000/svg"` and a `viewBox`. Custom SVGs render as images, preserving their own colors. For emoji, press Control-Command-Space on macOS or Windows-period on Windows to open the system picker. The `sessions` agent tool can set the same `icon` field. An empty value removes it. This decoration replaces the owner avatar in the leading glyph slot, but temporary attention state always takes precedence so an operator request cannot be hidden.

With **Person** grouping, hover or focus a person’s header and choose **Show only {name}** to filter to that owner, including yourself. Choose **Show everyone** on the active header to clear the owner filter. Active owner, **Involving me**, and non-default status filters appear beside **Sessions** in the toolbar. Click that summary to clear all filters and return to active sessions.

## Session colors

Choose **Icon & color** from a session menu and select a color swatch to add a narrow color stripe to its sidebar row and a matching dot beside the chat title. Pick one of eight colors, or choose **Default** to clear only the color. **Reset to default** clears both the icon and color. The colors match Claude Code’s `/color` names, so imported Claude Code sessions keep the same color. Imported catalog rows show their color without offering color editing.

## Direct session shortcuts

- **⌘⇧O** on Mac or **Ctrl+Shift+O** on Windows/Linux opens **New Session**
  and focuses its composer. It opens a draft, without creating an empty session
  or sending a message. **⌘N / Ctrl+N** remains **New Window**.
- **⌘⇧A** on Mac or **Ctrl+Shift+A** on Windows/Linux requests **Archive**
  for the current chat pane only, not other sessions selected in the sidebar.
  It uses the same permissions, protected-session checks, archive lifecycle, and
  **Undo** as the chat header menu. The archived conversation stays open; this
  is not a separate stop or delete action.

Both shortcuts work from the chat composer, ignore key repeat and text
composition, and leave open modal dialogs in control. The keyboard-shortcuts help
dialog is the exception for New Session: the shortcut closes help before opening
and focusing the draft. Press **⌘/** or **Ctrl+/** again to close help without
navigating. Archive remains blocked while help is open. New Session preserves the
existing conversation's draft through normal navigation. Archive does not clear
that draft or navigate to another conversation.

Browser shortcut handling can vary by browser version and configuration. If your
browser handles a chord itself, use the corresponding New Session control or
**Archive** in the current chat's header menu. The menu's **A** shortcut still
works while that menu is open.

In the macOS app, these additional shortcuts apply while the Dashboard web view
has keyboard focus. A separate native reading pane does not forward Archive to
the Dashboard or another window. The existing native **⌘N** New Gateway Window
and **⌘⇧N** New Thread commands are unchanged.

These direct shortcuts do not change the command palette's **⌘K / Ctrl+K**, then
**⌘Enter / Ctrl+Enter** workflow for starting a task in the background.

## Command palette

The command palette can start an independent task without leaving your current
conversation or settings page. Search sessions, settings, and commands as usual,
or write a prompt in the same field. Multiline text or a prompt of 60 or more
characters pauses palette searches and gently hides the search tabs, results, and
hints. The input stays anchored in place. Search returns when the text is
single-line and shortened to 50 characters or fewer, or cleared. Between 51 and
59 characters, the palette keeps its current mode to avoid flickering while you
edit. Counts exclude leading and trailing whitespace. Session-creation errors and
recovery actions remain visible in either mode.

Pasted images appear as small, removable thumbnails below the text. Pasting or
removing them leaves the input, **New session** action, and settings control in
place; the palette grows downward. Images can start a session on their own or
accompany text. There is no attachment picker in the palette.

Type **@** to search eligible people by name or verified GitHub handle, just as
in the chat composer. Use **↑/↓** or **Home/End**, then **Enter** or **Tab** to
select a person; **Escape** dismisses the people picker before the palette.
The compact **Will notify** row shows selected people once each, with **+N**
when space is tight. You can select up to ten mention references. Editing or
deleting a selected name removes that reference; **Remove mention** clears all
recipient selections without deleting the text. Pasted names and email addresses
remain ordinary text. The picker replaces search results while open, and selected
mentions keep the palette in composer mode. Mentions travel with the first message
of the new session; they never share a session, invite people, or grant access.

- **Enter** selects a person while the people picker is open; otherwise it opens
  or runs the selected search result. With no result, Enter does not send.
- **Shift+Enter** adds a line. The field grows downward to three lines, then scrolls
  without moving the palette or its top-right controls.
- **Command+Enter** on macOS or **Ctrl+Enter** on Windows/Linux starts a new session
  in the background. You can also choose **New session** beside the input.

Open **New session settings** beside the input to choose the agent, workspace and
machine, or whether to use a new worktree. These controls reuse the permissions
and device/cloud availability rules of the full New session page. Model,
attachment, and visibility controls remain on that page.

The palette starts with your usual defaults. Turn on **Remember settings** to
reuse different choices for Cmd/Ctrl+K without changing those defaults. Clearing
the checkbox restores your usual choices immediately and leaves the prompt
intact. One-off choices are not remembered for the next palette session.

Accepted creation closes the palette and offers **Open session** without changing
the foreground view or its draft. A failed submission retains the prompt, selected mentions, images, and
choices with an error. These settings do not affect sessions opened from search,
and the existing conversation composer keeps its own send and steer/queue
shortcuts. Long prompts remain intact for session creation and are never sent as
search queries.

## New session page

New session **+** controls are links: click to open the draft in the current browser tab, Command-click (macOS) or Ctrl-click (Windows/Linux) to open another tab, or right-click for the browser's **Open Link in New Tab/Window** menu. Middle-click works too. The smaller plus controls on group and catalog sections preserve their target in the new tab; your current conversation stays open.

The **+** in the sidebar's **Sessions** toolbar opens a full-page draft at `/new`: nothing is created until you send the first message. Separate destination and project controls choose where the session runs and which project or folder it uses. Connections with `operator.write` can choose **Local** (the Gateway host), **Auto** (least-busy device), or any paired device returned by `environments.list`; administrators additionally see configured cloud profiles and, when no devices are connected, **Connect a device**. A cloud profile is selectable when its advertised execution modes include the selected runtime, so one Crabbox profile row in the **Cloud** section supports both OpenClaw and Codex. For runtimes that consume worker slots, automatic selection first prefers eligible hosts with less admitted work relative to worker capacity, then compares free slots after accounting for pending dispatches, and breaks remaining ties by device ID. Runtimes that do not consume worker slots use device ID order. Device eligibility remains authoritative to the environment catalog and the selected runtime: OpenClaw `worker-turn` requires an available current session host with valid worker capacity and at least one free slot; Codex `remote-exec` requires its currently invocable, explicitly authorized exec-server command and consumes no worker slot. When that command is unavailable, the picker distinguishes a node that did not declare it, a declaration that awaits pairing approval, and a declaration blocked by Gateway command policy. Offline known hosts, connected non-hosts, incompatible or saturated hosts, hosts missing required capabilities, outdated hosts, and unavailable hosts remain visible with a reason and next step.

The destination picker opens with **Search environments** focused. Its compact, single-line results are grouped under **Local**, **Your devices**, and **Cloud**. Only the environment list scrolls. Local uses the Gateway's name when available, with a house icon; it means the Gateway host, not necessarily the computer running your browser. Connected Macs named MacBook, Mac mini, or Mac Studio use the matching hardware outline; unknown devices use a monitor. The macOS app shell supplies native SF Symbols for those three shapes; other clients keep the web outlines. This is a display-name hint, not hardware detection, and never changes placement eligibility. Search matches destination names, types, IDs, and device facts, including capabilities and unavailable reasons. Usable devices appear before unavailable devices. Hover or keyboard focus reveals device details and available capacity; blocked devices explain their reason and next step, while offline devices remain muted without a details card.

**Auto** is the first selectable row under **Your devices**, shown when more than one device is known. Its information icon explains how the device is chosen. Selecting Local, a device, or a cloud profile turns Auto off. When no devices are known, administrators see **Connect a device** in that section instead. Closing and reopening the picker clears its search.

Hover a configurable cloud profile or focus its row to open its operating-system and machine options. Unavailable operating systems are omitted. Before selecting a profile, dashed outlines identify the defaults; choosing any option selects that profile and activates the defaults for the other setting. The selected profile shows its operating system and machine as muted text beside its name in the menu. The closed selector keeps only the profile name. Options use equal-width tiles, up to four columns, with long catalogs scrollable.

The folder defaults to the agent workspace. Write-scoped connections can browse, restore recent Gateway folders, and start sessions anywhere inside a configured agent workspace; another absolute Gateway path requires `operator.admin` but can run directly without being a Git checkout. Local placement keeps the optional **Worktree** control with a base-branch picker backed by `worktrees.branches` (no fetch) and an optional worktree name (the branch becomes `openclaw/<name>`). Choosing a device or cloud profile with a Gateway folder selected uses a managed worktree. With a GitHub repository selected, **Remote checkout** sends its URL and optional ref directly to the runner without creating a Gateway checkout.

Leave **From** empty to fetch `origin` when creating the worktree and use its default branch. The placeholder is a suggestion, not a saved branch selection. Explicitly selected or saved branches and commits are used as entered without fetching; selecting local `main` uses that local branch, which can lag behind `origin/main`. If fetching or resolving the remote default fails, the Gateway falls back to the source checkout's `HEAD`.

### Start a native coding CLI

The **+** beside **Codex** or **Claude Code** opens a native CLI draft, not an
OpenClaw Chat. Choose the machine and folder, optionally enter a first prompt,
and press **Start in terminal** or Enter (or your configured submit shortcut).
The terminal opens with keyboard focus. The CLI uses that
machine's native account, model, and configuration; OpenClaw does not translate
model or authentication settings or automatically adopt the native session.
Native draft text is not sent to OpenClaw for automatic title preparation.
Ordinary **New Chat** and explicit catalog continuation remain separate flows.

Native starts require `operator.admin`, `gateway.cliAgents.enabled`,
an enabled catalog plugin, and its installed CLI. Terminals are on by default;
`gateway.terminal.enabled: false` blocks native starts.
No matching OpenClaw model route is required. Each machine has one launch
destination. The **Where** picker appears only when there is a choice or the
previously selected machine is unavailable. It lists the Gateway's native CLI
and connected nodes with the exact fresh-start command currently invocable;
resume-only nodes are not eligible. Availability updates after Gateway reconnects
and node connection or capability changes. After installing a CLI, reconnect to
the Gateway; after approving a node capability change, reconnect that node.

New Gateway-local Codex sessions use the primary native Codex profile configured
for its catalog, normally the Gateway user's `CODEX_HOME` or `~/.codex`. Selecting
a folder lets Codex load that project's trusted configuration; it does not select
another account or Codex home. Additional Codex homes remain available for browsing
and resuming existing sessions with their original profile. An OpenClaw agent's
temporary app-server login is separate from a native CLI login.

On the Gateway, the folder/worktree controls still provision the selected managed
worktree before launching. On a node, enter an existing absolute directory on
that node; create a worktree there first if needed. Native starts do not use
OpenClaw worker placement, cloud/Auto selection, attachment submission, model
controls, or Incognito. Add files and change native CLI settings in the terminal.
A missing directory, disabled capability, or disconnected host produces an error;
OpenClaw never starts a Chat or substitutes another host or home directory.
If the CLI exits during startup, the terminal retains its output and exit status.
If startup is rejected, the draft remains available to correct and retry.

### OpenClaw Chat workspace startup

On an OpenClaw Chat send, the submitted text and attachments appear immediately with a **Starting** indicator while the Gateway creates or adopts the session. This is a pending submission, not a Gateway acknowledgment. If creation is rejected, your prompt and attachments remain available to correct and retry. Once creation succeeds, the UI opens the session's chat. If navigation fails, the submitted message stays visible with an **Open session** action that retries navigation without creating or sending again. A background start keeps the same visible acknowledgment above the next draft, with a link to the created session.

Starting a suggested task keeps its instructions visible through acceptance, with **Task started** and **Open session** after confirmation. Interrupted acceptance remains visible, and Retry checks the same task. Skill Workshop revisions carry their submitted instructions into chat while history loads.

Attributed submissions show your avatar immediately, in the same position as the chat transcript. Opening the created session focuses the composer quietly; the attention cue is reserved for navigation that prefills a draft.

The project picker refreshes after sign-in and reconnects. Gateway reconnects and Git verification retries preserve your edited base branch and worktree name. Choosing another folder or project clears those repository-specific details.

For local worktree sessions, sending the first message opens the admitted session before naming, checkout, and setup finish. The chat shows the submitted message and preparation stages. A generated title is saved as soon as naming completes, independently of checkout and setup. Setup failures remain visible in that session; send a retry there after correcting the problem. The retry reuses the saved title. If naming itself fails, another attempt uses the original first prompt, including text attachments. Stopping during setup cancels preparation without starting the agent. Steering an active run keeps its progress visible, and delayed history cannot replace a newer startup stage or restore startup labels after activity begins.

For device and cloud sessions, the submitted prompt also starts background naming as soon as the session is created. The sidebar can show its topic while the worker is still provisioning; the first task turn waits until placement is ready. A prepared title or custom session name keeps precedence. Incognito sessions skip this early naming step.

For a remote target, the Control UI creates the repository or managed-worktree session with an empty initial message and no `execNode`, dispatches it by exact `deviceId`, `autoDevice: true`, or `profileId` (plus an optional cloud machine class), waits for active placement, and then sends the first message and attachments with the same idempotency key used by recovery. Explicit and automatic device dispatch require `operator.write`; cloud profile dispatch requires `operator.admin`. The composer footer chooses the new session's model and reasoning level.

Model and **Effort** are separate adjacent composer controls in chat and New session, on desktop and mobile. The model picker never contains Effort or Fast-mode controls. Long model labels ellipsize to leave room for the other controls; the full name remains in the picker, accessible label, and tooltip. Narrow composers, including split panes in wider windows, use compact controls so each picker stays independently clickable. Effort uses a gauge in these layouts whose needle reflects the current level, with a lightning badge when Fast mode is active. In chat, Fast mode stays in the Effort menu, or appears as the adjacent control when reasoning is unavailable. Models with neither available control omit it.

Search the model picker by model name, model ID, provider, or provider/model reference. Your search stays applied as the model catalog refreshes. Press **Escape** to clear a nonempty search while keeping the picker open; press it again to close the picker and return focus to its trigger.

When you switch sessions, the composer keeps the session's known model name visible while refreshing the model options available for that session. If the model is not yet known, the control shows a loading placeholder. Locked chats also show the selected model, or **Session model** when it is not known. The lock prevents model selection changes; it does not indicate that a native runtime owns the model.

Once the session is created, chat opens immediately. Remote startup uses the same transcript progress indicator and elapsed timer as GitHub workspace preparation, showing provisioning, workspace preparation, startup, and first-message delivery as they happen. The composer stays disabled until the first message is accepted; normal startup is not an error. Startup failures remain visible in the session, with **Retry** when recovery is available.

If startup recovery cannot load after a page reload, the session keeps the loading error and **Retry** available across session switches. Switching sessions does not restart recovery or reset its elapsed time. The saved first message continues holding later input until recovery loads and confirms its delivery state. While this page is responsive and unsaved starts await the recovery code, automatic in-app reloads are blocked and **Retry** is replaced by a warning. This includes Incognito starts and paused starts whose recovery could not be saved. Reload controls elsewhere in the app explain the same restriction. Choose **Discard unsaved starts and reload** to resume saved starts and discard the unsaved starts. The same action is available in the warning shown by other blocked Reload controls. This protection is limited to the open, responsive page; closing it or browser-managed navigation can still discard unsaved input. Incognito input is never saved to browser storage.

If remote startup fails before the first message is sent, chat retains the submitted text, attachments, selected destination, and a bounded error in the same browser tab and Gateway credential scope. Reloading shows the paused submission without provisioning another worker. **Retry** retains the repository URL/ref or Gateway worktree choice and uses the already-created session and the original profile and machine class, device, or Auto selection; it waits for active placement before sending. The session keeps its model and reasoning settings, including any later changes you make in that session. This tab-local startup recovery uses the tab's existing session-storage lifetime, separately from the ordinary browser draft limits below. Incognito startup recovery remains in memory only. An ordinary reconnect keeps the already-submitted prompt visible with **Reconnecting**, while send and retry actions remain unavailable. Changing the Gateway, credentials, or authenticated owner clears private presentation. Reconnecting does not release the first-turn hold: later input stays in the composer instead of entering the ordinary offline queue. Sessions without an unresolved initial turn keep normal offline queuing.

If the Gateway explicitly rejects the first send, **Retry** creates a new send attempt on that same session and destination. If delivery is uncertain, **Check delivery** looks for the original user message or an exact Gateway receipt showing that the input was retained or consumed. It never resends the prompt, provisions a worker, or treats missing history as proof that delivery failed. A matching receipt clears the browser startup hold without implying that the run has finished. The prompt stays visible until chat receives the corresponding Gateway-owned input or transcript message, then switches to that authoritative copy without duplication. Retained inputs keep their Gateway-owned status, including interrupted or cancelled inputs. Without a receipt, the prompt and attachments remain accessible and normal sending stays disabled. Inspect the conversation, or copy the retained prompt if you choose to start a separate attempt. This recovery does not promise exactly-once delivery across Gateway restarts. If browser storage rejects a recovery update, keep the current page open to preserve its in-memory input.

When an interrupted remote-placement draft needs deletion, cleanup reclaims the placement by session key, archives it with its expected session identity, then uses the write-scoped archived-only delete contract. Cleanup errors remain visible. If an interrupted Incognito startup is successfully cleaned up, the current pane keeps a read-only copy of its prompt and an interruption notice. It does not recreate the session or resend the message; the copy lasts only in the current browser tab and credential scope. Restoring paused or unconfirmed recovery does not itself request deletion.

Unsent text and staged attachments can be recovered only in the same browser profile and Gateway credential scope; they are never stored on the Gateway or synced across devices. The browser keeps the 20 most recently edited draft scopes per Gateway credential scope for up to seven days, with at most 25 MiB of attachment data per draft, but it can evict browser storage sooner. A successful send or New Session creation, explicit attachment removal, or confirmed session deletion retires the corresponding browser draft. If cleanup fails after deletion, clear site data for the Control UI origin to remove it. Clearing site data also removes every other browser draft. If a draft's attachments exceed the cap, the current tab keeps them and shows the existing storage warning, but only the text is restart-recoverable. OpenClaw **Incognito** drafts are never durable. Turning Incognito off resumes browser autosave for the current text and attachments, without requiring another edit. Switching New Session destinations, or leaving an existing Incognito chat for Settings and returning with Back, keeps unsent text and attachments in the current tab. Reloading or closing the tab discards that unsent input. Submitted Incognito messages in the tab-only inline outbox retain their separate reload behavior. In a private browser window, IndexedDB availability and lifetime are controlled by the browser and stored data is normally cleared when the private session ends. The **Incognito** toggle in the new-session page's top-right control rail retires that browser draft and creates a web-only thread whose session entry, transcript, and compaction state stay in memory for 24 hours after creation or until the Gateway restarts, whichever comes first; OpenClaw also skips its automatic memory flush. The agent keeps its normal tools, so an explicit save request or tool-driven file write can still persist data. The model provider still processes messages, and content-free audit metadata is still recorded. Remote-placement starts persist their model and reasoning choices before dispatching the session to its worker.

<a id="register-an-existing-repository" />

**Projects.** The Place picker lists configured agent workspaces and repositories recorded with `projects.register`. Read-only connections receive project names and IDs; checkout paths and origin URLs are included only at `operator.write`. An admin can browse to a Git checkout and choose **Register as project**; write-only operators see a hint directing them to that flow. Choosing a project sends its ID through `sessions.create`, so it can run directly or supply the source for optional Worktree isolation without submitting a raw path. If an agent workspace was moved or removed, update that agent's configured workspace path. If a recorded checkout was moved or removed, re-register it before starting another session there.

You can also register an existing checkout through the
[Gateway CLI](/cli/gateway/query#gateway-call-%3Cmethod%3E). Registration requires
`operator.admin`; listing requires `operator.read`.

```bash
openclaw gateway call projects.register \
  --params '{"path":"/srv/projects/example","name":"example"}' --json
openclaw gateway call projects.list --json
```

Use an absolute path on the machine running the Gateway, even when the CLI runs
on another machine. The Gateway service account must be able to access the Git
checkout, and its `HEAD` must resolve to a commit. Registration records the
existing checkout without cloning it. `name` is optional and defaults to the
checkout directory's name.

Registering the same resolved repository root again returns its existing project ID and
display name. Passing a different `name` does not rename an existing project.

**Projects from GitHub.** Search the same picker or paste a GitHub HTTPS or `git@github.com` repository URL. For a remote destination, creation records that source and the runner fetches it during dispatch; no Gateway project clone is required. For Gateway execution, the picker clones into the Gateway-managed projects area. Recent repository sources retain their URL without inventing a local path. Public repository search and cloning work anonymously. Private remote checkout uses the effective shared `tools.github` identity; the discovery credential below only grants picker access. For affiliated and private repositories, prefer the explicit `gateway.controlUi.github.token` SecretRef so this service access has a clear runtime owner. When it is omitted, the Gateway still uses its shipped `GH_TOKEN` then `GITHUB_TOKEN` fallback from the shared process environment. When it is explicit, its exact environment or store name is excluded from agent execution without clearing unrelated native GitHub CLI variables. Search requires `operator.read`, cloning requires `operator.write`, and deleting a Gateway-managed cloned checkout requires `operator.admin`. Clone deletion refuses while a live session or managed worktree still references the checkout. SecretRef ownership is not an OS-user security boundary; use a sandbox, dedicated host, or dedicated OS user when same-account processes are not trusted.

Use the Effort menu to choose Fast Mode before creating a session. New Session persists that choice before the first local or remote turn starts.

Refreshing sessions after an initial `/think` command finishes updates chat's Effort setting.

For agent GitHub CLI identity and Git author setup, see [`tools.github`](/gateway/config-tools#tools-github).

An expired Incognito link shows an expiration notice instead of an ordinary new conversation. **New Incognito session** opens a fresh private conversation and carries over unsent composer text and attachments within the current tab; it does not send them automatically. Previously submitted messages that were not sent remain on the expired conversation for copying or discarding, without a retry action.

On multi-user gateways, only admin-scope connections can create or view incognito threads, and other sessions cannot reach them through agent session tools or transcript search. Incognito protects against storage and other gateway-mediated users, not against the gateway owner or process operator, who can always observe live sessions.

**Browse folders** opens the Place picker's inline Gateway directory browser through `fs.listDir`. Typing in the path field filters the current folder's subfolders as you type (exact and prefix matches first, and hidden folders match only when the text starts with a dot); typing a new directory prefix lists that directory. Up/Down highlight a folder, Enter opens it, and Tab completes its name. Write-scope browsing starts at the configured agent workspace and cannot navigate above it; realpath checks also reject symlinks that escape the workspace. Admin connections can browse arbitrary Gateway paths. Recent places restore only Gateway folders the current connection can submit; New Session does not browse or remember node filesystem paths. Local submission can call `sessions.create` with the first message in the same round-trip. Remote submission uses the create, dispatch, then send sequence described above. If the Gateway creates the session but rejects that first send, the chat preserves the prompt and error across reloads; **Retry** sends it through the already-created session instead of creating another one.
