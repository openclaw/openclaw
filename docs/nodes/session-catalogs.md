---
summary: "Discover and continue Codex, Claude, OpenCode, and Pi sessions on paired nodes"
read_when:
  - Browsing Codex or Claude sessions that live on another computer
  - Resuming a native CLI session in its owning terminal
  - Configuring session catalog visibility or off-switches
title: "Node session catalogs"
sidebarTitle: "Session catalogs"
---

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
when the Anthropic plugin is enabled and `~/.claude/projects/` exists. Approve
the node pairing upgrade when those commands first appear.

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
`sessions.catalog.read` require `operator.read`; `sessions.catalog.continue` and
`sessions.catalog.archive` require `operator.write`.

Catalog visibility also follows the authenticated caller. An `operator.admin`
connection sees every discovered row. When the Gateway has durable profiles for
fewer than two people, catalog visibility is unchanged and rows remain unfiltered.
On a multi-user Gateway, a non-admin connection sees and can read, continue, or
archive only rows whose recorded `createdActor.id` matches the caller's Gateway
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
