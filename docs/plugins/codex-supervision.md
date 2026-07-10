---
summary: "List native Codex sessions and branch from them in OpenClaw"
title: "Supervise Codex sessions"
sidebarTitle: "Codex supervision"
read_when:
  - You want Codex Desktop or CLI sessions to appear in OpenClaw
  - You need to branch from or archive a stored or idle local Codex session
  - You are exposing Codex session metadata from paired nodes
---

Codex supervision is an opt-in capability of the official `codex` plugin. It
shows non-archived Codex sessions from the Gateway computer and opted-in paired
computers in one **Codex Sessions** page.

The initial release deliberately keeps ownership narrow:

- A stored or idle local session can create a model-locked OpenClaw Chat from
  its bounded persisted user and assistant history. The first message starts a
  native snapshot fork, then starts the full Codex harness thread with the model
  and provider that Codex App Server selected for that fork. The supervised
  binding keeps future turns on that native connection without allowing an
  outer OpenClaw model choice. An already-created branch opens its existing Chat.
- A stored session discovered from another Codex process has unknown live
  activity. It can branch, or it can be archived only after the operator
  confirms that no other Codex client is using it.
- An active source stays visible but cannot create a branch or be archived until
  its current turn finishes. If it already has a supervised Chat, **Open Chat**
  remains available.
- A session on a paired node stays visible as metadata only. Remote continuation
  requires a future streaming node bridge; remote archive additionally requires
  a runner-ownership lease or equivalent fencing.
- Archived sessions are not listed. A stored or idle local session can be
  archived only after the operator confirms that no other Codex client is using
  it.

## Before you begin

- Install the official `@openclaw/codex` plugin on the Gateway. The OpenClaw
  macOS app can install it when you enable Codex features; CLI installations can
  run `openclaw plugins install @openclaw/codex`.
- Install and sign in to Codex Desktop or the Codex CLI on each computer whose
  sessions you want to list.
- Pair remote computers as OpenClaw nodes. Each computer must opt in locally;
  enabling supervision only on the Gateway does not authorize another node.
- Use an owner-controlled Gateway. Session titles, working directories, and Git
  branches can reveal sensitive project information.

## Enable supervision

Selecting a detected Codex backend during guided `openclaw onboard` or macOS
first-run setup enables Codex supervision after the live Codex check passes. An
existing explicit `supervision.enabled: false` remains an opt-out. Existing
installations can enable the same capability manually:

Enable the `codex` plugin and its supervision capability in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          supervision: {
            enabled: true,
          },
        },
      },
    },
  },
}
```

If `plugins.allow` is present, include `codex`. Restart the Gateway after
changing plugin activation.

With no explicit `appServer` connection settings, supervision uses a separate
managed stdio supervision connection against the native user Codex home. The
ordinary Codex harness remains agent-scoped by default. This makes native
sessions visible in both apps without making ordinary OpenClaw turns share
native Codex state. Set `appServer.homeScope: "user"` explicitly if the harness
should share that state too. Supervision honors explicit `appServer` connection
settings instead of replacing them with its local user-home default.

A Chat created through **Codex Sessions** is not an ordinary harness session.
Its private supervision binding uses the supervision connection for source
reads, canonical branch creation, history injection, and every later turn. With
the default local connection, that preserves the native user Codex home, auth,
and provider configuration without changing the default for other sessions.

For the default local supervision connection, the store is shared with native
Codex clients; the live App Server process usually is not. Current Codex Desktop
releases use their own stdio App Server unless the app has been separately
configured for Codex's experimental local daemon. OpenClaw therefore treats a
thread that its supervision App Server reports as `notLoaded` as **Stored / activity
unknown**, not as idle.

Apply the same opt-in on every headless node host whose sessions should appear.
The native OpenClaw macOS app reads the same local setting when it advertises
its Codex catalog to the paired Gateway. That paired native Mac catalog supports
only the default or explicit `appServer.transport: "stdio"` with an unset or
explicit `appServer.homeScope: "user"`. `command`, `args`, and `clearEnv` are
honored for that stdio process. If the Mac config selects `"unix"`,
`"websocket"`, or `homeScope: "agent"`, the app does not advertise the catalog
capability or command, and a stale direct invocation fails instead of exposing
the user Codex home or spawning a different local stdio App Server.

A newly advertised node command changes the node's approved command surface.
Approve the update from the Gateway host:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Open **Codex Sessions** in the Control UI. The page lists non-archived sessions
grouped by host. Search matches normalized session titles; refresh and per-host
pagination preserve healthy hosts when another host is offline or unavailable.

## Branch from a local session

Choose **Continue as branch** on a stored or idle row from the Gateway computer.
OpenClaw creates a normal Chat entry, mirrors bounded user and assistant history
through the source's last terminal persisted turn (completed, interrupted, or
failed), records a pending harness branch, and opens the Chat. The generic model
picker is locked, but no concrete model or provider has been selected yet. The
source is not resumed, and the canonical harness thread is not started yet.
Repeating the action opens the existing Chat instead of creating another
branch.

Send the first normal Chat message to begin work. The Codex harness installs the
real approval, elicitation, event, and delivery handlers. It uses a temporary
native fork on the supervision connection to pin the source snapshot without
supplying a model or provider override. Codex App Server selects both from its
current native configuration and returns the actual selection. On that same
connection, OpenClaw starts the canonical `appServer`-source full harness thread
under its cwd and runtime policy with exactly that returned pair, injects the
bounded visible history, and archives the temporary fork. The canonical thread
has the full OpenClaw harness tool surface. This is a visible-history branch, not
a full native rollout clone: source reasoning, tool calls, and tool results are
omitted. This and every later turn stays on the supervised Codex connection
rather than another OpenClaw model runtime or the ordinary agent-home harness.

The returned selection is not proof of the source's historical model. If the
current native configuration differs from the model recorded for the source's
last turn, Codex emits its normal model-difference warning. OpenClaw uses the
returned pair for the canonical thread start. On later resumes it omits model and
provider overrides so Codex's native configuration continues to own the
effective selection; Codex may report a changed pair or another native warning.
OpenClaw never substitutes its outer model or fallback chain.

The supervised model-locked Chat cannot switch models, use `/new` or `/reset`,
invoke the Gateway session-reset action, or use the generic **Fork session**
action. Mutating `/codex model <model>`, `/codex
bind`, `/codex resume` (including a node session with `--bind here`), and
`/codex detach` or `/codex unbind` are also rejected because they would replace
or clear the locked native binding. The `/codex model` query and `/codex fast`,
`/codex permissions`, and `/codex threads` remain available. Start another
ordinary session when you want a different model or fresh thread.

Keep supervision enabled for this Chat. If supervision is disabled or its
stored connection binding becomes unavailable or inconsistent, the turn fails
closed instead of moving to an ordinary agent-home session.

The `codex_threads` agent tool follows the same boundary. It cannot attach a
different fork or archive the Chat's bound native thread. List and metadata-only
read remain available. Raw transcript reads require `allowRawTranscripts`;
rename, unarchive, detached fork, and archive of an unrelated thread require
`allowWriteControls`. Neither option bypasses the locked binding.

OpenClaw does not subscribe to or answer approval requests while merely listing
the source thread or displaying the pending Chat. Starting a distinct canonical
harness thread on the first turn lets another Codex process keep owning the
source without creating competing rollout writers.

The original CLI or VS Code source remains visible to native clients and the
OpenClaw catalog. The canonical branch is stored as a native Codex thread, but
its source kind is `appServer`; Codex Desktop or another native client may filter
that source kind, so the branch itself is not guaranteed to appear in every
native history view.

An active row reported by OpenClaw's App Server cannot start a new branch. Wait
for the current turn to finish and refresh the catalog. Codex App Server
serializes mutations within one process, but it does not provide an exclusive
cross-process runner or approval-owner lease.

For a **Stored / activity unknown** row, the Chat mirror and first-turn snapshot
pin use Codex's state through the last terminal persisted turn. The source
thread is not resumed, interrupted, or archived. If another process has an
in-progress turn, its latest in-flight work might not be present in the branch.

## Archive a local session

Choose **Archive** on a stored or idle Gateway-local row, then confirm that Codex
Desktop, the CLI, and other clients are not using that thread. OpenClaw freshly
reads the process-local status, proceeds only for `idle` or `notLoaded`, calls
the native Codex archive operation, and removes the session from the
non-archived list.

Archive is unavailable when the session is active, has an error status, or
belongs to a paired node. The confirmation is required because App Server status
is not shared across independent stdio processes; OpenClaw cannot prove that
another process is not using a row that appears idle or is not loaded locally.
Restore an archived thread with Codex Desktop, the Codex CLI, or an
owner-authorized native thread-management flow; it reappears after unarchive.

## Understand paired-node limits

Paired nodes expose the versioned read-only
`codex.appServer.threads.list.v1` command. The Gateway receives normalized
metadata, not raw App Server endpoints or transcripts. The current node invoke
transport is request/response only, so it cannot carry the long-lived event,
approval, and streaming lifecycle required by the Codex harness.

For that reason, remote rows remain visible but do not offer **Continue** or
**Archive**, even when the remote thread is idle. Use Codex on that computer
until a node-side streaming runner bridge exists for continuation and a safe
runner-ownership boundary exists for archive.

## Metadata and permissions

Catalog rows may include:

- thread and session identifiers
- title and working directory
- current status and active wait flags
- created, updated, and activity timestamps
- source, model provider, Codex CLI version, and Git branch

The paired-node projection excludes transcript previews, turns, rollout paths,
the Codex home path, Git remotes, commit SHAs, and raw App Server errors. Catalog
access requires the `operator.write` Gateway scope because fleet aggregation
uses the standard `node.invoke` path, even though the node command is read-only.

`supervision.allowRawTranscripts` and `supervision.allowWriteControls` govern
autonomous agent and standalone MCP tools. Both default to `false`. With
supervision enabled, `codex_threads` removes transcript previews and turns from
list and metadata-only read results unless raw transcripts are allowed; a
turn-inclusive read fails closed. Every fork, rename, archive, and unarchive
requires write controls. These options do not grant additional Control UI
actions or bypass binding, host, status, or confirmation checks.

For every supervision config field, see
[Codex harness reference](/plugins/codex-harness-reference#supervision).

## Troubleshooting

**No sessions appear:** verify that `@openclaw/codex` is installed, both the
plugin and `supervision.enabled` are true, the current plugin allowlist permits
`codex`, and the sessions are not archived. Restart the Gateway or node after
changing activation.

**Continue is disabled:** an unmapped row is active, belongs to a paired node,
its host is offline, or another action is pending. Gateway-local stored and idle
rows offer **Continue as branch** instead of unsafe exact-thread takeover. A row
that already has a supervised Chat offers **Open Chat**.

**Archive is disabled:** archive is available for stored/activity-unknown and
idle Gateway-local rows after no-other-runner confirmation. Active, error,
offline, and paired-node rows remain read-only for archive.

**An archived session disappeared:** this is expected. The supervision page has
no archived view. Unarchive the thread in a native Codex client to show it
again.

**Old `codex-supervisor` config remains:** run `openclaw doctor --fix`. Doctor
moves the retired plugin entry and related plugin-policy references into
`plugins.entries.codex.config.supervision` without overwriting explicit Codex
settings.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Codex supervision architecture](/specs/codex-supervision)
- [Nodes](/nodes)
- [Gateway security](/gateway/security)
