---
summary: "Optional Workboard boards for agent-owned cards and utility-model categorized sessions"
read_when:
  - You want a Kanban-style workboard in the Control UI
  - You are enabling or disabling the bundled Workboard plugin
  - You want to track planned agent work without an external project manager
  - You want sessions grouped by run state and utility-model judgment
title: "Workboard plugin"
---

The Workboard plugin adds an optional Kanban-style board to the
[Control UI](/web/control-ui): agent-sized work cards, assignment to agents,
and a link back to the card's task, run, and Control UI session. A separate
**Sessions board** groups existing sessions into editable columns using session
state and the configured utility model.

Workboard is intentionally small: it tracks local operating work for one
OpenClaw Gateway. It is not a replacement for GitHub Issues, Linear, Jira, or
other team project management systems.

## Enable it

Workboard is bundled but disabled by default:

1. Open **Plugins** in the Control UI, or use `/plugins` relative to the
   configured Control UI base path. For example, a base path of `/openclaw`
   uses `/openclaw/plugins`.
2. Open the **Workboard** plugin, select **Lifecycle**, and turn on the enabled
   switch. Because Workboard is included with OpenClaw, it does not need an
   **Install** action.
3. Wait for the lifecycle action to finish, then open the Workboard tab.

The Workboard tab appears in the Control UI nav after the plugin runtime loads.
While it is disabled, the tab stays hidden from navigation. Opening the
`/workboard` route directly while the plugin is disabled or blocked by
`plugins.allow`/`plugins.deny` shows a plugin-unavailable state instead of card
data.

The equivalent CLI workflow is:

```bash
openclaw plugins enable workboard
openclaw dashboard
```

Enablement applies to a running Gateway automatically. If it is offline, start
it before opening the dashboard. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Configuration

Workboard has no plugin-specific config. Enable/disable it with the standard
plugin entry:

```json5
{
  plugins: {
    entries: {
      workboard: {
        enabled: true,
        config: {},
      },
    },
  },
}
```

```bash
openclaw plugins disable workboard
```

## Board appearance

Choose **New board**, then **Cards** (the default) or **Sessions**. A Sessions
board starts with the columns described below. A board's kind is permanent;
create another board to use the other kind. Existing boards remain Cards boards.

Use **Edit board** to change a board's name, icon, and color. **Reset to default**
clears the icon and color when you save; canceling leaves the saved board unchanged.
For Sessions boards, the same dialog also edits column labels, colors,
descriptions, the fallback column, and classification instructions.

For `workboard.boards.upsert`, omitting `icon` or `color`, passing `null`, or passing
an empty string preserves the existing value, including for older clients. To clear
appearance explicitly, send `clearAppearance: ["icon", "color"]`, or list only the
field you want to clear. Listed fields are cleared even if the request also supplies
a replacement value for them. Other fields retain their ordinary update behavior.
`clearAppearance` must be an array containing only `"icon"` and `"color"`; an empty
array changes nothing. Clients using this argument need a Gateway version that
supports explicit appearance clearing; older Gateways do not implement this reset.

## Sessions board

Use a Sessions board to see where your conversations stand without creating
cards. By default, it includes sessions from all configured agents with activity
in the last 72 hours and excludes archived sessions. Each session appears in
exactly one column. Open a tile to continue its conversation; the tile also shows
its agent, run state, observer headline when available, pull requests, and recent
activity. The agent filter narrows the displayed sessions without changing the
saved board scope.

**People filter:** Choose **Everyone** (the default), **Involving me**, or a person
beside the agent filter. Involving me shows sessions you own or previously prompted;
a person selects their profile associations. The choice is remembered per viewer,
device, Gateway, and board. It does not change the shared board, classification, or
the Board agent. API clients can pass `view: { involvingMe?: boolean,
involvingProfileId?: string, includePeople?: boolean }` to
`workboard.sessionsBoard.read`; `includePeople` returns the people facet for the picker.

Classification is shared across the Gateway. Reads follow the current caller's
session visibility; the board and its
classification cache follow the Gateway's trusted-operator model.
Interactive edits are admitted under the caller's live authority immediately before the write, while background classification runs under the plugin service's authority.
Background classification uses the Gateway system actor to see non-incognito, non-draft shared sessions independently of who opened the board, including when roles are configured.
Draft sessions are creator-private and never enter a Sessions board, its facts reads,
or utility-model requests; incognito sessions are excluded the same way.
Before the first classification returns any sessions, an empty board shows
**Classifying sessions…** and refreshes when classification completes.

New Sessions boards use these columns, in this order:

| Column      | Deterministic rule                                                                 | Utility-model guidance                                                  |
| ----------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Needs input | Observer health is `waiting-on-user`.                                              | Questions, approvals, or decisions waiting for the user.                |
| Working     | Run is active **and** observer health is `on-track`, `grinding`, or `wrapping-up`. | Work in progress, including active runs without an observer digest yet. |
| Stuck       | Observer health is `stuck` or `failed`.                                            | Failed runs and work that cannot continue without intervention.         |
| In review   | A pull request is open or draft.                                                   | Work awaiting review.                                                   |
| Merged      | A pull request is merged.                                                          | Landed work.                                                            |
| Done        | Observer health is `done`. This is also the fallback column.                       | Idle or finished work with nothing else outstanding.                    |

Placement first checks column `match` rules in their saved order. Every field in
a rule must match; values within a field are alternatives. The first matching
column wins. Health rules require an observer digest, which exists only for
observed runs. Without a matching rule, the utility model chooses from the column
ids and descriptions using compact session facts. For example, it can recognize
an idle session whose last reply asks for approval. Missing or invalid model
placements use the fallback column with the reason `unresolved`.

Nonempty board instructions send sessions through utility-model judgment even
when a state rule matches. Ask for distinctions such as “keep documentation
reviews separate from code reviews,” then add columns with descriptions explaining
that distinction. Column names are free-form and do not change card statuses.

Drag a session into another column to pin its placement. Pins win over rules and
the model until the session's placement facts change; classification then resumes.
Tile tooltips distinguish **by rule**, **by model**, and **pinned**. **Refresh**
requests reclassification. Reads return cached placements immediately, and an
inline warning preserves the board when utility-model inference is unavailable.
An inference failure keeps prior placements; new unresolved sessions use the
fallback. A missing or failed utility model never falls back to the primary model.

When the Control UI host supports a session dock, **Board agent** opens a
conversation beside the board. Its first use creates and saves a dedicated
conversation named **Sessions board · &lt;board name&gt;**. Ask that agent to change
columns, instructions, scope, or placements using these tools:

| Tool                              | Arguments and behavior                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `workboard_sessions_board_read`   | Optional `boardId`; returns board, columns, cached sessions, and any warning.                                                                  |
| `workboard_sessions_board_update` | Optional `boardId`, plus `columns`, `instructions`, or `scope`. `columns` replaces the complete ordered list; retain ids when renaming labels. |
| `workboard_sessions_board_move`   | Optional `boardId`, required `sessionKey` and `columnId`; pins that session's placement.                                                       |

These three tools are available to every agent once the plugin is enabled; unlike
the card tools they need no `tools.allow` entry, so the Board agent works out of
the box. Omit `boardId` only when exactly one Sessions board exists. The dock attaches page
context to the conversation, but plugin tools do not receive that context as a
structured argument. With several Sessions boards, the agent must pass the board
id from that context or from `workboard_boards`.

Specs allow 2–12 columns with unique lowercase slug ids (1–48 characters), labels
(1–60), and descriptions (1–400). Exactly one column must have `fallback: true`.
Optional colors use the board palette. Instructions allow up to 2,000 characters.
`scope` accepts `agentIds`, `includeArchived`, and a positive `maxAgeHours`.
Rules can match `health`, `run` (`active`, `idle`, `failed`), `pullRequest`
(`none`, `open`, `draft`, `merged`, `closed`), and `archived`. Unknown pull-request
state does not count as `none`.

The Gateway methods are `workboard.sessionsBoard.read` (`operator.read`) and
`workboard.sessionsBoard.update`, `.move`, and `.refresh` (`operator.write`). All
require `boardId`. Update takes a `patch` object with the spec fields, including
the dock's `agentSessionKey`; move additionally requires `sessionKey` and
`columnId`. Create with `workboard.boards.upsert` and `kind: "sessions"`, or with
`workboard_board_create`. Changing an existing board's kind is rejected.

Classification reuses Workboard's minute session sweep and agent completion
hooks, but only for boards that an operator or tool read within the last 15
minutes; an unviewed board costs nothing until it is opened again. Only changed
session facts or board specs need reclassification; activity timestamps alone do
not count as a change, so pins survive ordinary session activity. Facts
reads batch at most 40 sessions. Utility requests group sessions by their owning
agent and classify at most eight sessions per group per pass to fit each call's
600-token response cap. Groups run sequentially within one board pass, with at
least 30 seconds between passes. Larger groups classify in the background while
prior placements or the fallback column remain visible. Previews are bounded and
redacted before inference. Each group uses its session agent's utility model, or
the board's `orchestration.defaultAssignee` when set, so multi-agent Gateways need
no implicit default owner. A failed group retains its prior placements without
blocking the other groups. Session state, observer digests,
and pull-request state stay owned by the Gateway; Workboard stores only the board
spec and placement cache in its SQLite tables.

Sessions boards never hold cards: card creation, capture, and dispatch reject a
Sessions board destination. Deleting one removes its placement cache without
deleting any sessions or its Board agent conversation.

## Card fields

| Field       | Values                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `status`    | `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`                     |
| `priority`  | `low`, `normal`, `high`, `urgent`                                                                             |
| `labels`    | free-form strings                                                                                             |
| `agentId`   | optional assigned agent                                                                                       |
| linked refs | optional task, run, session, or source URL                                                                    |
| `execution` | optional metadata for a Codex/Claude run started from the card (engine, mode, model, session, run id, status) |

Cards also carry compact metadata:

| Metadata      | Values                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| card state    | attempts, comments, links, proof, artifacts, automation settings, attachments, worker logs, worker protocol state, claims, diagnostics, notifications, template id, archive state, stale-session detection                                                                                                                                                   |
| recent events | `created`, `edited`, `moved`, `linked`, `specified`, `decomposed`, `claimed`, `heartbeat`, `execution_updated`, `attempt_started`, `attempt_updated`, `comment_added`, `link_added`, `proof_added`, `artifact_added`, `attachment_added`, `diagnostic`, `notification`, `dispatch`, `orchestration`, `protocol_violation`, `archived`, `unarchived`, `stale` |

This metadata lets an operator see how a card moved through the board without
opening the linked session. It is local operating context, not a replacement for session
transcripts or GitHub issue history.

The plugin and Control UI use one Workboard card contract. Control UI refreshes
therefore preserve workspace provenance and authority, claim state, diagnostic
actions, and notification sequence numbers instead of projecting a smaller
UI-only copy of the card. Unknown diagnostic kinds, diagnostic severities, and
notification kinds are ignored until both surfaces support them. They are never
rewritten into another valid state.

The open Workboard tab updates from `plugin.workboard.changed` invalidations. Each
event contains only a store epoch and revision. The UI then rereads canonical
cards through the normal `operator.read` RPC. Multiple revisions coalesce into
one follow-up read. Workboard defers that read while a card is being dragged,
edited, or written, then resumes after the local interaction finishes. A
reconnect always performs a canonical reload. There is no routine full-card
poll, and **Refresh** remains available as manual recovery.

When more than one board exists, the toolbar includes a **Board** filter backed
by persisted board metadata rather than only the currently visible cards. Empty
and archived boards therefore remain selectable. Cards without an explicit
board id belong to the canonical `default` board. Each board has a canonical
`/workboard/<boardId>` page that can be bookmarked, shared, or pinned in the
sidebar. The previously shipped `/workboard?board=<boardId>` form remains a
compatibility alias and redirects to that page while preserving other query
parameters. Choosing **All boards** returns to `/workboard`.

A board can store an `automationJobId` reference to the automation job that
owns its AI-categorization prompt, model, schedule, and run history. The board
page shows an **Automation** link when that reference is present. Matching
session events nudge the attached automation through the active Workboard service's
scheduler authority, including after the worker's tool authority closes, with events
for the same board coalesced for 60 seconds. The automation's schedule remains
the backstop. Disabled and auto-disabled automations are never nudged. Deleting
the board does not delete or otherwise mutate the
operator-owned automation job.

Cards are stored in the plugin's own Gateway state and move with the rest of
that Gateway's OpenClaw state (see [Storage](#storage)).

## Starting work from a card

Unlinked cards without an active or unresolved task association can start work directly:

- **Run Claude** / **Run OpenAI** starts a task-tracked agent run with an
  explicit engine, sends the card prompt, and marks the card `running`. Claude
  runs use `anthropic/claude-sonnet-4-6`. OpenAI runs use `openai/gpt-6-astra`.
- **Open Claude** / **Open OpenAI** creates a linked Control UI session without
  sending the card prompt, for manual work that stays attached to the board.
  Opening it clears any schedule and moves a `scheduled` card to `todo`.
  Other cards keep their status.

Autonomous starts use the Gateway's task-tracked agent run path (default agent
and model unless Claude/OpenAI is chosen explicitly). Workboard then links the
resulting run id and session key back onto the card. Each linked
execution also records an attempt summary (engine, mode, model, run id,
timestamps, status, rolling failure count) so repeated failures stay visible.

The Control UI reads lifecycle from the card's linked session. Card status changes are persisted by the Gateway-side Workboard
plugin using the linked run and session lifecycle (see
[Session lifecycle sync](#session-lifecycle-sync)).

## Agent tools

| Tool                                                                                                                                             | Purpose                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workboard_list`                                                                                                                                 | List compact cards with claim/diagnostic state; optional board filter.                                                                                                                    |
| `workboard_read`                                                                                                                                 | Return one card plus bounded worker context (notes, attempts, comments, links, proof, artifacts, parent results, recent assignee work, active diagnostics).                               |
| `workboard_create`                                                                                                                               | Create a card with optional parents, tenant, skills, board, workspace metadata, idempotency key, runtime limit, retry budget.                                                             |
| `workboard_link`                                                                                                                                 | Link a parent to a child card. Children stay `todo` until every parent reaches `done`, then dispatch promotion moves them to `ready`.                                                     |
| `workboard_claim`                                                                                                                                | Claim a card for the calling agent; moves `backlog`/`todo`/`ready` into `running`.                                                                                                        |
| `workboard_heartbeat`                                                                                                                            | Refresh the claim heartbeat during a longer run.                                                                                                                                          |
| `workboard_release`                                                                                                                              | Release the claim after completion, pause, or handoff; can move the card to a next status.                                                                                                |
| `workboard_complete` / `workboard_block`                                                                                                         | Structured lifecycle tools for final summaries, proof, artifacts, and created-card manifests (must reference cards linked back to the completed card) or blocker reasons.                 |
| `workboard_attachment_add` / `workboard_attachment_read` / `workboard_attachment_delete`                                                         | Store small card attachments in plugin SQLite state, index on the card, expose in worker context.                                                                                         |
| `workboard_worker_log` / `workboard_protocol_violation`                                                                                          | Record worker log lines and block a card when an automated worker stops without calling `workboard_complete`/`workboard_block`.                                                           |
| `workboard_board_create` / `workboard_board_archive` / `workboard_board_delete`                                                                  | Manage persisted board metadata (display name, description, archive state, default workspace).                                                                                            |
| `workboard_sessions_board_read` / `workboard_sessions_board_update` / `workboard_sessions_board_move`                                            | Read Sessions board placements, edit free-form columns/instructions/scope, or pin a session in a column.                                                                                  |
| `workboard_runs`                                                                                                                                 | Return the persisted run-attempt history for a card.                                                                                                                                      |
| `workboard_specify`                                                                                                                              | Turn a rough triage/backlog card into a clarified `todo` card; records the spec summary on the card.                                                                                      |
| `workboard_decompose`                                                                                                                            | Fan a parent orchestration card into linked children, inheriting board/tenant metadata; can complete the parent with a created-card manifest.                                             |
| `workboard_notify_subscribe` / `workboard_notify_list` / `workboard_notify_events` / `workboard_notify_advance` / `workboard_notify_unsubscribe` | Manage notification subscriptions. Event reads are replay-safe; `advance` moves the durable cursor so callers resume without losing or double-reading completed/failed/stale card events. |
| `workboard_boards` / `workboard_stats`                                                                                                           | Inspect board namespaces and queue stats.                                                                                                                                                 |
| `workboard_promote` / `workboard_reassign` / `workboard_reclaim`                                                                                 | Recover or hand off stuck work.                                                                                                                                                           |
| `workboard_comment` / `workboard_proof`                                                                                                          | Add handoff notes or attach proof/artifact references.                                                                                                                                    |
| `workboard_unblock`                                                                                                                              | Move blocked work back to `todo`.                                                                                                                                                         |
| `workboard_move`                                                                                                                                 | Move a card to another status; claimed cards require the caller's agent claim scope.                                                                                                      |
| `workboard_dispatch`                                                                                                                             | Nudge dependency promotion or stale-claim cleanup without launching workers; worker launch uses Gateway or slash-command dispatch.                                                        |

Proof statuses are worker-reported outcomes, not independent verification. A `passed`
entry means the worker reports that its command or check succeeded. Consumers that need
an independent quality gate should inspect the attached command, URL, or artifact and
run their own verifier. `workboard_proof` returns the new record's `proofId`. When
`workboard_complete` reports that same proof's terminal status, pass `proofId` so the
pending record is resolved in place without losing its identity or timestamp. A proof that
already has the same terminal status is reused unchanged. Completion proof without
`proofId` remains append-only, so a later retry cannot rewrite older history merely because
its command or note is identical.

Claimed cards reject agent-tool mutations from other agents unless the caller
holds the claim token returned by `workboard_claim`. Every card returned by an
agent tool or Gateway RPC call redacts `metadata.claim.token` to `[redacted]`
(the token itself is returned once, top-level, only from `workboard_claim`),
so Control UI operators and other agents can inspect claim state without ever
seeing a usable token. Recovery goes through
`workboard_promote`/`workboard_reassign`/`workboard_reclaim`, which do not
require the token.

## Dispatch

Dispatch is Gateway-local: it does not spawn arbitrary OS processes. Normal
OpenClaw subagent sessions still own execution. One dispatch pass:

1. Promotes dependency-ready cards.
2. Blocks expired claims or timed-out runs.
3. Marks board-configured triage cards as orchestration candidates.
4. Claims a small batch of ready cards and starts worker runs through the
   Gateway subagent runtime.

Idle scans leave ready-card history unchanged. Existing dispatch counters and
timestamps remain as historical values; new launches use the card's launch,
attempt, and execution history.

Workers get bounded card context plus the claim token needed to heartbeat,
complete, or block the card through the Workboard tools.

Workspace paths follow the caller's existing filesystem authority:

- Gateway clients with `operator.write` can use configured agent workspaces.
- `operator.admin` clients can use other host checkouts.
- Sandboxed agent tools use their sandbox workspace access.
- Unsandboxed workspace-only tools use their configured workspace root.

Workboard records that authority when a workspace is
assigned and intersects it with the current caller's authority again at dispatch,
so a persisted card cannot widen a later caller's access. Older cards with an
explicit host workspace but no recorded authority must have that workspace
re-saved before a full-host dispatch. Cards without a host path adopt the
current caller's authority when first dispatched.

Workspace-bound dispatch accepts a directory or Git checkout only when its
repository root exactly matches the target agent workspace. A worktree request
is narrowed to that directory and persisted as a directory workspace, so the
host does not materialize the checkout or execute repository setup code. The
target worker must use a writable, non-shared Docker sandbox for that exact
workspace, without elevated execution, persisted host/node exec overrides, or
unclassified plugin and MCP tools. Workboard enumerates its registered tools
instead of trusting a `workboard_*` prefix, and dispatch refuses a hot Docker
container whose live mount/config hash is stale. Dispatch reports the
incompatible target policy instead of starting a less-confined worker.
Full-host dispatch may target other local checkouts and keeps normal managed-
worktree setup.

Workspace authority does not create a second card-lifecycle permission model.
Callers that may mutate Workboard cards can manually move them through the same
statuses on every surface. Read-only workspace access only prevents worker
dispatch that needs writes.

### Worker selection

Each pass starts **at most 3 workers by default**. Ready cards are ordered by
priority, then position, then creation time. A pass starts only one card per
owner/agent and skips owners that already have running or review work on the
board. Archived cards, cards with an active claim, and cards not in `ready`
status are never selected for worker starts (they can still be affected by the
data side of dispatch: stale-claim cleanup, dependency promotion, timeout
cleanup).

Session keys are deterministic per board/card, so repeated dispatches route
back to the same worker lane instead of creating unrelated sessions:

- Assigned cards: `agent:<agentId>:subagent:workboard-<boardId>-<cardId>`
- Unassigned cards: `subagent:workboard-<boardId>-<cardId>` (Gateway resolves
  the configured default agent)

If a worker cannot be started after a card is claimed, Workboard blocks the
card, clears the claim, records the run-start failure, and appends a worker
log line - visible in the Control UI, CLI JSON, agent tools, and card
diagnostics.

### Entry points

- Control UI dispatch action
- `openclaw workboard dispatch`
- `/workboard dispatch` on a command-capable channel

All three use the Gateway subagent runtime when the Gateway is available. The
CLI has one operator fallback: if the Gateway call fails with a
connection/unavailable error (or an `unknown method` error for older
Gateways), and no explicit `--url`/`--token` target and no configured remote
Gateway (`OPENCLAW_GATEWAY_URL` or `gateway.mode: remote`) apply, the CLI runs
data-only dispatch against local SQLite state - it can promote dependencies,
clean stale claims, and block timed-out runs, but cannot start workers. Auth,
permission, and validation failures from a reachable Gateway are not treated
as unavailable. They surface as command errors, and so does any Gateway
failure when an explicit `--url`/`--token` target was given.

Board metadata can set `autoDecompose`, `autoDecomposePerDispatch`,
`defaultAssignee`, and `orchestratorProfile`. OpenClaw records this intent and
exposes it in worker context. Actual specification/decomposition still runs
through the normal Workboard tools.

## CLI and slash command

```bash
openclaw workboard list [--board <id>] [--status <status>] [--include-archived] [--json]
openclaw workboard create "Fix stale card lifecycle" --priority high --labels bug,workboard
openclaw workboard show <card-id> [--json]
openclaw workboard move <card-id> --status <status> [--json]
openclaw workboard dispatch [--board <id>] [--json]
```

`list` text output hides archived cards by default (`--include-archived`
overrides). `--json` always includes archived cards, matching the full-card
contract used by existing scripts. `show` and `move` accept an unambiguous id
prefix. `list`, `create`, `show`, and `move` always read/write local plugin
state directly. Only `dispatch` calls the running Gateway, with the fallback
described above.

See [Workboard CLI](/cli/workboard) for full flags, JSON output, Gateway
fallback behavior, id-prefix handling, dispatch selection rules, and
troubleshooting.

`/workboard list`, `/workboard show <card-id>`, `/workboard create <title>`,
`/workboard move <card-id> --status <status>`, and `/workboard dispatch` mirror
the CLI. List and show are read operations for any authorized command sender.
Create, move, and dispatch require owner status on chat surfaces, or a Gateway
client with `operator.write`/`operator.admin`. Manual operator moves use the
same claim-override behavior as Control UI drag-and-drop. Their worktree access
still follows the same workspace boundary described above.

## Session lifecycle sync

Cards can link to an existing Control UI session, or one created when you
start work from the card. Linked cards show the session lifecycle inline:
running, stale, linked idle, done, or failed. You can also capture an
existing session from its header or the Sessions tab with **Add to Workboard**. The card
links to that session, uses the session label or recent user prompt as title,
and seeds notes from the recent user prompt plus the latest assistant response
when available.

Capture keeps the destination board selected when you start the action. It
reloads an inactive board's cards before reusing one, restores an archived
exact match, and never infers session ownership from a provisional link.

Captured sessions show **Open Workboard card** and a linked-card chip. Both use
the same card state, including after a browser reload. Opening a card outside
the current agent filter switches the board to **All agents** without changing
the selected chat agent.

Opening a card loads its linked session details independently of the sidebar's
agent filter and pagination. While details are loading or unavailable, the
card keeps its link and shows **Session state unknown** or **Session
unavailable**. An ambiguous provisional link shows **Session link ambiguous**.
Edit the card to select an exact session. Use **Refresh** to retry. To continue
an existing session, select its exact link in **Edit card** and choose **Open
session**. To start fresh, clear the link in **Edit card**. Clearing the link
retains its task association, so **Start** remains unavailable while that task
is active or unresolved. Changing a card's assignee does not change the owner
of its existing session.

Bare `global` and `unknown` links do not identify a session owner. They show
**Session link ambiguous** when opened. Use **Edit card** to select an explicit
session. Workboard does not offer these bare links for new captures or links.

If an active linked session stops reporting recent activity, Workboard marks the card
`stale` and stores that as metadata until the lifecycle clears it.

Lifecycle writes are owned by the Gateway-side Workboard plugin, so they do
not depend on an open browser tab. Agent and subagent completion hooks persist
terminal outcomes immediately. A bounded session sweep runs once per minute to
reconcile active, idle, missing, and stale session state. Each store mutation
emits the normal `plugin.workboard.changed` invalidation, so an open Workboard tab
reloads the canonical card instead of writing its own lifecycle projection.

While a card is in an active work state, Workboard follows the linked session:

| Linked session state                  | Card status |
| ------------------------------------- | ----------- |
| active                                | `running`   |
| completed                             | `review`    |
| failed, killed, timed out, or aborted | `blocked`   |

**Manual review states win.** Moving a card to `review`, `blocked`, or `done`
stops auto-sync for that card until you move it back to `todo` or `running`.

Starting a card uses normal Gateway sessions. Workboard only stores card
metadata and links. Conversation transcript, model selection, and run
lifecycle stay owned by the regular session system. Use **Stop** on a live
linked card to abort the active run - Workboard marks that card `blocked` so
it stays visible for follow-up.

New cards can start from Workboard templates (`bugfix`, `docs`, `release`,
`pr_review`, `plugin`). Templates prefill title, notes, labels, and priority.
The template id is stored as card metadata.

<a id="dashboard-workflow" />

## Control UI workflow

1. Open the Workboard tab in the Control UI.
2. Create a card with a title, notes, priority, labels, optional agent, and
   optional linked session - or open Sessions and choose **Add to Workboard**
   for an existing session.
3. Drag the card between columns, or focus its compact status control and use
   the menu or ArrowLeft/ArrowRight. During a drag, the source card dims and
   available drop columns gain an outline.
4. Start an unlinked card when it has no active or unresolved task association.
5. Open the linked session from the card while the agent works.
6. Let lifecycle sync move running work into `review`/`blocked`, then manually
   move the card to `done` when accepted.

### Session-board widgets

Workboard ships three native widgets for session dashboards (see
[Dashboards](/web/dashboards)). The agent pins them with its `dashboard` tool
using `content: { kind: "plugin", pluginKind, props }`, and they render as
first-party UI with live data — no sandbox frame or capability grant:

- `workboard:card` with `props: { cardId }` shows one card with its status
  control, priority, and assigned agent.
- `workboard:board` with optional `props: { boardId }` shows the full Kanban
  board with draggable cards and status controls. Without `boardId` it shows
  every board. With `boardId` it shows only that board.
- `workboard:mini` with optional `props: { boardId, limit }` shows per-status
  counts plus the top ready/running cards, and links to the full board page.
  Without `boardId` it aggregates every board. With `boardId` it scopes to that
  board (cards created without an explicit board id live on `default`).

## Diagnostics

Diagnostics are computed from local card metadata. Built-in checks flag:

| Kind                        | Condition                                                                      |
| --------------------------- | ------------------------------------------------------------------------------ |
| `stranded_ready`            | Assigned `todo`/`backlog`/`ready` card not updated in over 1 hour.             |
| `running_without_heartbeat` | `running` card with no claim heartbeat or execution update in over 20 minutes. |
| `blocked_too_long`          | `blocked` card not updated in over 24 hours.                                   |
| `repeated_failures`         | Card's tracked failure count reaches 2 or more.                                |
| `missing_proof`             | `done` card with no proof, artifacts, or attachments.                          |
| `orphaned_session`          | `running` card with a `sessionKey` but no `execution` metadata.                |
| `archived_but_active`       | Archived card remains in any non-`done` lifecycle status.                      |

## Permissions

Gateway RPC methods live under `workboard.*`. Sessions board methods use the same
read/write scopes as boards:

| Scope            | Methods                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator.read`  | `cards.list`, `cards.export`, `cards.diagnostics`, attachment list/get, notification event reads, `boards.list`, `cards.stats`, `cards.runs`                                                                                                                                                                                                                                                            |
| `operator.read`  | `sessionsBoard.read`                                                                                                                                                                                                                                                                                                                                                                                    |
| `operator.write` | `cards.diagnostics.refresh`, create/captureSession/update/move/delete/comment/link/linkDependency/proof/artifact, attachment add/delete, worker log, protocol violation, claim/heartbeat/release/promote/reassign/reclaim/complete/block/unblock/start, `cards.dispatch`, `cards.bulk`, archive, `boards.upsert`/`archive`/`delete`, `cards.specify`/`decompose`, notification subscribe/delete/advance |
| `operator.write` | `sessionsBoard.update`, `sessionsBoard.move`, `sessionsBoard.refresh`                                                                                                                                                                                                                                                                                                                                   |

`workboard.cards.update`, `workboard.cards.move`, `workboard.cards.archive`, and
`workboard.cards.delete` accept an optional `expectedUpdatedAt` request field.
Pass the finite numeric `updatedAt` from the card you read to guard the write.
If the card has changed, the request fails with `workboard_conflict` and returns
its latest card in `error.details.card` (`error.details.type` is
`workboard_card_conflict`). Review that card before retrying. Omitting the field
keeps the method's existing unguarded request behavior.

Control UI bulk actions use each card's observed revision and stop on a conflict.
Remaining cards stay selected for review and retry; the batch does not silently
retry against newer revisions or overwrite another client's changes.

No RPC method requires `operator.admin`. Browsers connected with read-only
operator access can inspect the board but cannot mutate cards. An admin scope
widens accepted Workboard host paths. It does not change the methods available.

## Storage

Workboard stores durable data in a plugin-owned relational SQLite database
under the OpenClaw state directory: boards, cards, labels, lifecycle events,
run attempts, comments, dependency links, proof, artifact references,
attachment metadata and blobs, diagnostics, notifications, worker logs,
protocol state, and subscriptions all live in Workboard tables (not
plugin key-value entries). A card export preserves the board narrative
without inlining attachment blob contents.

Sessions boards add optional `kind` and `sessions_spec` columns to
`workboard_boards`, plus `workboard_session_placements` for cached column, source,
reason, facts hash, and update time. Existing board rows are not backfilled;
an absent kind still means a Cards board. Rolling back to a release without Sessions
boards shows each Sessions board as an empty Cards board and ignores the placement
table; cards created against it there are rejected once the newer release runs again. Session transcripts and the Board agent
conversation remain in the normal session store.

SQLite opening, queries, and transactions run in a background database worker.
Disabling or reloading the plugin drains admitted storage work before closing
its connections.

Installations with retained pre-July 2026 Workboard plugin-state KV data must
upgrade through OpenClaw `2026.9.7` and run `openclaw doctor --fix` before upgrading
to the latest version. Current Doctor reports this requirement without changing
the legacy rows; current relational SQLite stores remain supported.

## Troubleshooting

**The tab says Workboard is unavailable**

```bash
openclaw plugins inspect workboard --runtime --json
```

If `plugins.allow` is configured, add `workboard` to it. If `plugins.deny`
contains `workboard`, remove it before enabling the plugin.

**Cards do not save**

Confirm the browser connection has `operator.write` access. Read-only operator
sessions can list cards but cannot create, edit, move, or delete them.

**Starting a card does not open the expected session**

Check the card's agent id and linked session, then open Sessions or Chat to
inspect the actual run state.

**Dispatch does not start a worker**

Confirm there is at least one `ready` card without an active claim:

```bash
openclaw workboard list --status ready
```

If the CLI reports data-only dispatch, start or restart the Gateway and
retry - data-only dispatch updates local board state but cannot start
subagent worker runs. Cards can also be skipped when another card for the
same owner or agent is already running or waiting for review. Complete,
block, or release that active work before dispatching more for the same
owner.

## Related

- [Control UI](/web/control-ui)
- [Workboard CLI](/cli/workboard)
- [Plugins](/tools/plugin)
- [Manage plugins](/plugins/manage-plugins)
- [Sessions](/concepts/session)
- [Managed worktrees](/concepts/managed-worktrees)
