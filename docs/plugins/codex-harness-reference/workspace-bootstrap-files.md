---
summary: "Which workspace bootstrap files reach a Codex turn, and how they are carried"
read_when:
  - You need to know how AGENTS.md reaches Codex
  - You are debugging persona or memory context in Codex turns
  - You are hitting prepared-context size limits
title: "Codex workspace bootstrap files"
sidebarTitle: "Workspace bootstrap files"
---

How `AGENTS.md`, persona, skills, and memory files reach a native Codex turn. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## Workspace bootstrap files

The full generic developer policy, including a `before_prompt_build.systemPrompt`
replacement, remains native session configuration for compaction and native-child
inheritance. Ordinary persistent cold or changed-configuration resumes require an
uninterrupted managed local stdio process owner and observed native unload before OpenClaw injects the full
current policy. Merely sending `developerInstructions` on `thread/resume` does not
refresh the model-visible policy on stock Codex. Explicit `systemPrompt: ""` sends
a withdrawal, not a fallback to older instructions.

Ordinary incognito turns can reuse unchanged generic policy, but changed or emptied
policy is rejected without sending another native turn or discarding the live
conversation. Parent-local model-request instructions remain a separate surface.
See [Hook boundaries](/plugins/codex-harness-runtime#hook-boundaries) for recovery.

Codex normally handles `AGENTS.md` itself through native project-doc discovery.
OpenClaw does not write synthetic Codex project-doc files or depend on Codex
fallback filenames for persona files, because Codex fallbacks only apply when
`AGENTS.md` is missing. Ordinary policy-restricted turns have no native
filesystem environment, so OpenClaw instead sends the bounded workspace
`AGENTS.md` snapshot as thread-level developer instructions. Ring-zero,
lightweight, message-only, and tool-disabled internal turns suppress that
carrier.

For OpenClaw workspace parity, local tool notes live in the `## Tools` section
of `AGENTS.md` and normally ride Codex's native project-doc discovery. The
Codex harness forwards the other bootstrap files as developer instructions:

- On the managed bundled stdio app-server, `SOUL.md`, `IDENTITY.md`, and
  `USER.md` are added to **parent-only model request instructions**. The
  private relay leaves native base/catalog instructions and history intact,
  so newly delivered persona and user-profile context are not automatically
  inherited by native Codex subagents.
- The compact loaded OpenClaw skills list uses the same parent-local layer.
- Heartbeat turns receive generic initiative guidance through collaboration
  mode. Monitor cron scratch is appended to the heartbeat prompt instead of
  injected as workspace context.
- `MEMORY.md` content from the configured agent workspace is not pasted into
  native Codex turn input when memory tools are available for that
  workspace; when it exists, the harness adds a small workspace-memory
  pointer to the parent-local instruction layer and Codex
  should use `memory_search` or `memory_get` when durable memory is relevant.
  If tools are disabled, memory search is unavailable, or the active
  workspace differs from the agent memory workspace, `MEMORY.md` uses the
  bounded turn input reference path instead.
- `BOOTSTRAP.md`, when present, uses the same turn input reference path.
  These references are introduced on the first turn of a new native thread,
  after a cold resume (including a Gateway restart), after native compaction,
  or when their rendered content changes. Unchanged references are omitted
  on subsequent warm turns once the complete reference block has been submitted.
  If prompt fitting drops or truncates the block, a later turn introduces it again.
  Tracking is process-local; reference content
  remains ordinary user input in native history.

The managed relay supports native API-key and ChatGPT accounts on the standard
OpenAI endpoints and also works with Gateway-owned inference plus `remote-exec`. Its HTTP and WebSocket hops honor
the Gateway's HTTP(S) proxy and TLS configuration. Native login, token refresh,
backend routing, and approval-reviewer checks stay native-owned. It rejects oversized
prepared context instead of truncating it (256 KiB maximum); model request bodies
and WebSocket frames are bounded at 32 MiB. Reduce bootstrap/skills budgets or
attached context when those limits are exceeded.

Custom commands, Desktop attachments, external Unix/WebSocket connections,
non-OpenAI native providers, custom upstream endpoints, unsupported native account
modes, locked upstream configuration, and native `features.respect_system_proxy` profiles keep the legacy
collaboration carrier, which model-owned catalog instructions
can replace. A warning and unverified persona accounting identify that the
workaround is not active. OpenClaw does not reroute or shut down those sessions.
Previously embedded persona, conversation text, and explicit task handoffs are
not removed from existing histories or full-history forks.
