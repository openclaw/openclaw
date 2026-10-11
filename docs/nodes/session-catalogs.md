---
summary: "Discover, import, and continue native session transcripts on the Gateway and paired nodes"
read_when:
  - Browsing Codex or Claude sessions that live on another computer
  - Resuming a native CLI session in its owning terminal
  - Preserving native transcripts in OpenClaw before source cleanup
  - Configuring session catalog visibility or off-switches
title: "Node session catalogs"
sidebarTitle: "Session catalogs"
---

Catalog listing waits up to one second per provider, concurrently. Providers that
finish within that budget return normally. A slow provider returns
`catalog.error.code: "catalog_pending"`; when available, its latest available page
for the same caller and query is included with hosts marked `pending: true` and
a stale-results message. A failed catalog enumeration can likewise return that page with
`catalog.error.code: "catalog_stale"` and the underlying error in its message.
Completed host results are authoritative, including offline or unavailable hosts;
the Gateway does not replace those results with older rows, even while another
host is pending. Providers own their
host snapshot freshness and invalidation. Other providers remain usable. Late results refresh the page for the next list;
existing host progress updates remain supported.

These fallback pages are bounded in memory and invalidated by configuration or
provider registration changes and catalog archive operations. Every delivery
rechecks current visibility and local session identity. The one-second budget
covers provider discovery and queueing, not session-projection preparation or
time spent waiting for the Gateway event loop.

With diagnostics enabled, slow-provider warnings report elapsed time, including
queueing and asynchronous I/O. `isMainThread` identifies the calling thread; it
does not measure CPU time. Debug logging emits each provider ID and its
`providerIdHash` once per provider registration so warnings can be attributed
without logging session content.

## Import transcripts

Import a native transcript into OpenClaw's durable session store to keep it after
the source tool cleans up its history or the source computer becomes unavailable.
In the sessions sidebar, open a catalog row's menu and choose **Import to OpenClaw**.
The success notification offers **Open imported session** when the copy is ready.

From the CLI, import one transcript or all visible catalog rows:

```bash
openclaw sessions import claude <thread-id>
openclaw sessions import codex <thread-id> --host <host-id>
openclaw sessions import --all --dry-run
openclaw sessions import --all --json
```

Catalog IDs are `claude`, `codex`, `openclaw`, `opencode`, and `pi` for the bundled
providers. Use `--catalog <id>` to filter a bulk import and `--source-home <id>`
to select an individual transcript from a particular source home. See
[sessions CLI](/cli/sessions) for connection options and bulk-import output.

Import works with any readable catalog, including sources on the Gateway,
headless paired nodes, the macOS app, and the Linux app. The source must be
reachable during import. The imported copy is an ordinary OpenClaw session owned
by the selected agent, with source provenance and an untrusted-reference notice.
Imported copies start as [drafts](/concepts/multi-user#drafts), visible only to
their creator and Gateway admins. Publish the copy through the existing session
sharing controls to share it with other people. Re-importing preserves the copy's
current visibility, including an explicitly published copy.
When drafts are disabled, imported copies follow the Gateway's default visibility.
The Control UI and CLI `--all` supply the catalog row's name as the initial title
when available. A single-session CLI import uses a generic
`Imported <catalog label> session` title. RPC callers can supply `displayName`
(1–500 characters) for a new imported session; re-importing never renames an
existing session. It has no native model lock or node execution binding, and
importing does not resume or fork the native session. The source transcript
remains unchanged.

Re-importing the same catalog, host, source home, and thread for that agent
updates the same OpenClaw session. Only previously unseen transcript items are
appended; an unchanged source adds zero items. This is an explicit sync: later
native messages are preserved when you import again.

Import preserves the catalog's projected transcript text, not the original native
files or raw provider records. Each import retains up to 50,000 transcript items
or 64 MiB of projected history, whichever comes first, starting with the most
recent history. Provider truncation and the existing per-item text limit still
apply. If the history ceiling omits older items,
the result has `complete: false` and the CLI warns that the copy is incomplete.
`importedItems` counts newly appended source items; `totalItems` counts source
items read during this import, including items already preserved. Claude and
Codex supply stable item IDs; for catalogs whose items lack IDs, re-import
identifies items by content, so an identical repeated item can be skipped once
a transcript exceeds the history ceiling. The smaller
continuation seed remains limited to 200 items and 512 KiB.

Import requires `operator.write` and the same row visibility as reading a
catalog transcript. In multi-user mode, non-admin callers can import only rows
they may read. Source read access is checked through each destination write;
revocation stops further copying, while content already committed remains in the
imported session. Importing a copy does not adopt the native session or change what
clicking its catalog row opens.

## Codex sessions and transcripts

The official `codex` plugin can expose non-archived Codex sessions on a
headless node host or native macOS node. Catalog registration no longer depends
on `supervision.enabled`; that option gates the agent-facing supervision tools.
Set `sessionCatalog.enabled: false` in the Codex plugin config to disable the
operator catalog and paired-node catalog commands without disabling the
provider or harness.
The plugin must still be active on both computers, and the node setting remains
local consent: enabling only the Gateway cannot read another computer's Codex
state.

The node advertises the versioned read-only
`codex.appServer.threads.list.v1` and
`codex.appServer.thread.turns.list.v1` commands. A native node host with the
Codex CLI available also advertises `codex.terminal.resume.v1`. Approve the node pairing
upgrade when those commands first appear. The Gateway invokes them through the
normal plugin node policy and isolates failures by host.

Paired-node rows appear as a **Codex** group in the normal sessions sidebar.
Within each host, rows group by project folder by default; a working directory
under `.claude/worktrees/<name>` folds into its origin repository, and project
groups collapse like other sidebar sections. Use the folder icon in the catalog
header to flatten or restore the project groups. The same grouping applies to
the Claude sessions catalog.
By default, selecting a row opens the normal Chat pane and reads its persisted transcript
through bounded, cursor-paginated
`thread/turns/list` calls with full item projection. Use the row menu, the viewer header, or the **Open Codex/Claude sessions in** preference to start `codex resume <thread-id>` in the operator terminal on the computer that owns the session. The paired-node terminal path is an allowlisted PTY relay owned by the Codex plugin, not arbitrary node command execution.

The terminal relay is separate from paired-node Chat continuation. A connected
node that advertises and permits both catalog commands plus
`codex.cli.session.resume` can continue a stored or idle interactive thread for
an operator with `operator.admin`. The Chat mirrors bounded visible history;
later messages run native Codex CLI resume against the exact thread on that
node and return the final text, without a streaming App Server harness bridge.
Nodes without the required commands remain readable without Chat continuation.
Paired-node **Archive** is unavailable.

On the Gateway computer, stored and idle rows can start a distinct model-locked
Chat branch. Either can be archived only after the operator confirms that no
other Codex client is using it; a stored row's live activity remains unknown.
Active rows cannot branch or archive.

See [Supervise Codex sessions](/plugins/codex-supervision) for setup,
pagination, local and paired-node continuation, and the metadata security boundary.

## Claude sessions and transcripts

The bundled `anthropic` plugin discovers non-archived Claude CLI and Claude
Desktop sessions on the Gateway and paired nodes by default. Set
`plugins.entries.anthropic.config.sessionCatalog.enabled: false` to disable the
operator catalog and paired-node catalog commands without disabling Anthropic
models or the Claude CLI backend.
A remote macOS app node advertises
`anthropic.claude.sessions.list.v1` and `anthropic.claude.sessions.read.v1`
when the Anthropic plugin is enabled and its Claude projects directory exists:
`$CLAUDE_CONFIG_DIR/projects/` when the app's environment sets
`CLAUDE_CONFIG_DIR`, otherwise `~/.claude/projects/`. Claude Desktop metadata
always comes from the user's home directory. Approve the node pairing upgrade
when those commands first appear.

A native node host with the Claude CLI available also advertises
`anthropic.claude.terminal.resume.v1`. Eligible CLI and Desktop rows can open
`claude --resume <session-id>` in the operator terminal on their owning host.
This is a takeover of the native session; unlike OpenClaw adoption, it does not
fork the Claude session first.

The catalog combines valid Claude CLI project-index records with a bounded
metadata fallback for unindexed JSONL transcripts. That fallback recognizes
concurrent non-sidechain interactive (`cli`) and headless Agent SDK CLI
(`sdk-cli`) sessions. Claude Desktop's local metadata supplies Desktop titles and archive
state. Desktop metadata wins when both sources refer to the same Claude Code
session ID; CLI-only transcripts remain visible because the CLI has no archive
flag. Transcript reads use opaque
byte-offset cursors and bounded backward file reads, so selecting a large
session or loading an older page does not read the whole JSONL history into one
Gateway response.

Catalog RPCs keep their normal method scopes: `sessions.catalog.list` and
`sessions.catalog.read` require `operator.read`; `sessions.catalog.continue`,
`sessions.catalog.import`, and `sessions.catalog.archive` require `operator.write`.

Catalog visibility also follows the authenticated caller. An `operator.admin`
connection sees every discovered row. When the Gateway has durable profiles for
fewer than two people, catalog visibility is unchanged and rows remain unfiltered.
On a multi-user Gateway, a non-admin connection sees and can read, continue,
import, or archive only rows whose recorded `createdActor.id` matches the caller's Gateway
profile. Unattributed host CLI or desktop sessions are hidden from those callers.
This is a privacy and coordination boundary inside one trusted Gateway domain,
not hostile-user isolation; use separate agents or Gateway/host trust boundaries
when people must not share access to files, credentials, or tools. See
[Multi-user mode](/concepts/multi-user).

A Gateway-local Claude CLI row can be adopted from the normal Chat composer:
OpenClaw imports bounded visible history, resumes with `--fork-session` on the
first turn, and leaves the source transcript untouched.

A headless node host can opt into the same continuation flow:

```json5
{
  nodeHost: {
    agentRuns: {
      claude: { enabled: true },
    },
  },
}
```

The node advertises `agent.cli.claude.run.v1` only when this node-local setting
is enabled and the `claude` executable resolves on that node. The Gateway cannot
enable it remotely. The command also passes through the node's existing exec
approval policy. When all three Claude commands are advertised and permitted by
the Gateway's node command policy, a Claude CLI
row on that node becomes continuable: OpenClaw imports bounded history, binds
the adopted session to the node and its catalog-reported working directory, and
runs each one-shot `claude -p` turn there. The first turn still uses
`--fork-session`, preserving the source transcript.

Node-placed turns use the node's Claude defaults. In v1 they do not receive the
Gateway loopback MCP config or Gateway skills plugin, cannot reseed from a
Gateway transcript, and reject attachments and images. Claude Desktop rows and
nodes that do not advertise the run command remain view-only. The macOS app
node does not advertise this command yet, so its rows remain view-only.

## OpenCode and Pi sessions

The bundled OpenCode and ACPX plugins also discover read-only native session
catalogs on the Gateway and paired nodes. A node advertises
`opencode.sessions.list.v1` / `opencode.sessions.read.v1` when the `opencode`
CLI is installed, and `acpx.pi.sessions.list.v1` / `acpx.pi.sessions.read.v1`
when Pi's session directory exists. Approve the node pairing upgrade when new
commands first appear. When the matching CLI is also available, the node adds
`opencode.terminal.resume.v1` or `acpx.pi.terminal.resume.v1`; the existing row
menu and viewer header can then reopen the selected session in its owning
terminal with `opencode --session <id>` or `pi --session <id>`.

OpenCode reads through its official CLI JSON/export surface. Pi reads its
documented JSONL session store, including project and global `settings.json`
session directories plus `PI_CODING_AGENT_DIR` and
`PI_CODING_AGENT_SESSION_DIR` overrides. Both catalogs are enabled by default;
turn them off in the Web UI under **Config > Plugins**.

Terminal resume uses the stored session working directory and the same
allowlisted duplex PTY relay as Codex and Claude. It does not expose arbitrary
node command execution.

## OpenClaw sessions and transcripts

The bundled [Session Share plugin](/plugins/session-share) publishes selected
native OpenClaw sessions from a source Gateway to a paired receiver Gateway.
The source node host runs as the same user with the source Gateway's state
directory. Enable the plugin on both sides, choose source session groups, and
connect with only `openclaw.sessions.list.v1` and
`openclaw.sessions.read.v1` in `--commands`.

The receiver shows read-only rows under the source node in **OpenClaw sessions**.
Viewers need permission to view others' sessions on role-restricted Gateways.
This does not permit continuation, terminal access, or worker execution on the
source. It is separate from hosting new sessions on a node, described in [Session hosting](/nodes/session-hosting).
