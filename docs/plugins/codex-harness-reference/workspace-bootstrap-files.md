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

Ordinary threads replace Codex's model prompt with OpenClaw's own policy through
`thread/start.baseInstructions`, the same execution, tool-call, care, control, and
documentation sections the regular engine renders, plus a short Codex runtime
section covering its channels, steering, compaction, and native tools. The text
renders from thread-stable facts only, so turn, channel, workspace, and skill
facts keep their existing carriers below. A changed base prompt reaches an
existing thread on its next cold resume; restricted threads rotate instead, and
incognito threads reject the change like any other generic policy change.
Side-question forks carry the parent's current base, so they match a parent
whose base changed on a cold resume. When Codex configuration sets
`model_instructions_file` or `instructions` (for example in `~/.codex/config.toml`
with `appServer.homeScope: "user"`), that operator policy stays the base and
OpenClaw sends its policy at the start of the developer instructions instead.
Ring-zero threads keep empty base instructions, and app-server tool declarations
are unchanged. Supervised threads, including canonical forks, have no outer
OpenClaw runtime plan, so their provider guidance resolves from the thread's
native provider and model. Their authentication and routing stay native.

The full generic developer policy, including a `before_prompt_build.systemPrompt`
replacement, remains native session configuration for compaction and native-child
inheritance. Ordinary persistent cold or changed-configuration resumes require an
uninterrupted app-server client and observed native unload before OpenClaw injects
the full current policy. OpenClaw must be the sole lifecycle owner of the native
conversation, including when its app-server runs remotely. Independent clients
that can reload the same conversation during the handoff are outside this contract;
observed unload does not reserve the conversation against a competing resume.
Local and remote transports use the same conversation ID through unsubscribe and
resume. Merely sending `developerInstructions` on `thread/resume` does not
refresh the model-visible policy on stock Codex. Explicit `systemPrompt: ""` sends
a withdrawal, not a fallback to older instructions.

A `systemPrompt` replacement, including an empty one, replaces the base instructions
too, as the replacement replaces the whole prompt on the default engine. OpenClaw sends
an empty base and does not move its policy into the developer instructions, so the
replacement is the only OpenClaw-supplied policy. An existing thread keeps its ID and
history: the changed base takes the cold-resume path, which settles and unloads the
thread before `thread/resume` replaces its saved base in place. Every cold resume sends
the intended base. When Codex configuration authors `model_instructions_file` or
`instructions`, that operator base stays.

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

- `SOUL.md`, `IDENTITY.md`, and workspace-root `USER.md` share a refreshable
  thread developer section on every connection, including managed direct stdio
  app-servers and Desktop executables launched by OpenClaw for Computer Use.
  It stays in the cached native prompt prefix, and native Codex subagents can
  inherit it.
- The compact loaded OpenClaw skills list uses the same thread section.
- The selected memory plugin's prompt builder receives the complete available
  tool set, including deferred plugin tools. Its guidance uses the same
  thread section independently of `MEMORY.md` file routing.
- On managed connections, the private relay adds only parent-only text to each
  model request's instructions: a selected personal `users/<profile-id>/USER.md`
  overlay, cron policy, plugin system context, and per-turn conversation context.
  The relay leaves native base/catalog instructions and history intact, so this
  text is not inherited by native Codex subagents.
- Heartbeat turns receive generic initiative guidance through collaboration
  mode. Monitor cron scratch is appended to the heartbeat prompt instead of
  injected as workspace context.
- `MEMORY.md` content from the configured agent workspace is not pasted into
  native Codex turn input when memory tools are available for that
  workspace; when it exists, the harness adds a small workspace-memory
  pointer to the same thread section and Codex
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
attached context when those limits are exceeded. The relay validates each native request
and its current parent registration before forwarding. Requests that need no
parent-local instructions keep their native JSON bytes, including existing zstd
compression on HTTP. Requests with parent-local instructions still receive the
same bounded instruction injection.

Desktop executable selection and Computer Use permissions stay unchanged. The
relay belongs to the direct stdio process OpenClaw starts, not to the Desktop
application's other conversations.

Custom commands, Desktop proxy attachments, external Unix/WebSocket connections,
non-OpenAI native providers, custom upstream endpoints, unsupported native account
modes, locked upstream configuration, and native `features.respect_system_proxy` profiles
run without the relay and use only the thread developer section below. OpenClaw does not reroute their inference
or change their native account configuration.
Previously embedded persona, conversation text, and explicit task handoffs are
not removed from existing histories or full-history forks.

<a id="skill-catalogs-without-a-managed-relay" />
<a id="skills-persona-and-memory-without-a-managed-relay" />

### Skills, persona, and memory on the thread

On every connection, eligible skills, shared persona (`SOUL.md`, `IDENTITY.md`,
workspace-root `USER.md`), and memory guidance share a refreshable thread developer
section. Model-owned collaboration instructions cannot replace this section, and it
stays in the cached prompt prefix: Codex sends it as a developer input item, and later
requests in the same turn only append to it. Native children can inherit it.
Managed threads created before this layout receive the section once on their next
turn, after the Gateway restart that installs it, through the cold resume below.

Selected personal `users/<profile-id>/USER.md` overlays are excluded from this
section. Thread configuration and history can both be inherited by native
children, so neither is a parent-only carrier. Managed relay connections deliver
the selected personal overlay to the parent only, in request instructions; that
overlay is not cached on models that never cache `instructions`. Connections without
a relay use shared user preferences only, log a warning when a personal overlay is
omitted, and report zero injected characters for it.

A changed or removed section reaches an idle persistent thread through a cold resume,
which sends the complete current developer instructions; they also survive native
compaction. While background work (a running native command or child) protects a
persistent thread, the thread is not cold-resumed for a section change: it receives an
injected developer message holding the complete current section, so the next turn is
not blocked, and the first later turn without protected work cold-resumes it. A live
incognito thread has no resume source and always receives the injected message.
Missing sections are explicitly withdrawn, and earlier history stays unchanged.
Changing other generic policy still cold-resumes an ordinary persistent thread; a live
incognito thread rejects that change.

An injected section (incognito threads, and persistent threads until their protected
work ends) has two limitations. First, automatic compaction can restore the thread's
section from its last start or resume for the immediate continuation before OpenClaw
re-delivers the current section; restoration applies to the following request. On
managed relay connections the relay also sends the current section in request
instructions while it differs from the thread's native copy, so the continuation
still sees it; connections without a relay keep this one-request window. Second, a
fresh native child without inherited history can receive that earlier section
rather than subsequent injected edits. A full-history child can inherit the later
handoff. Standalone compaction invalidates recorded delivery so the next turn
refreshes it, including after a failed restore. These refreshes do not erase older
instructions from history.

Lightweight cron turns omit skills. When such a turn shares a thread with ordinary
turns, that omission withdraws the thread-level catalog until the next ordinary turn.
