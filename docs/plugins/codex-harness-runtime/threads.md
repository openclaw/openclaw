---
summary: "How OpenClaw binds native Codex threads, changes models, and continues supervised sessions"
read_when:
  - You are switching models on an attached Codex thread
  - You are branching or archiving a supervised Codex session
title: "Codex thread bindings and supervision"
sidebarTitle: "Threads and supervision"
---

Thread binding rules for ordinary and supervised Codex sessions, including safe continuation from an existing native thread. Part of the [Codex harness runtime](/plugins/codex-harness-runtime) guide; [Where each section moved](/plugins/codex-harness-runtime#where-each-section-moved) lists every section.

## Thread bindings and model changes

When an OpenClaw session is attached to an existing Codex thread, the next
turn resends the currently selected model, approval policy, sandbox,
approvals reviewer, and service tier to app-server. Switching from
`openai/gpt-5.5` to `openai/gpt-5.2` keeps the thread binding but asks Codex to
continue with the newly selected model.

Supervised bindings are the exception. The OpenClaw model picker stays locked,
and resumes omit model and provider overrides so Codex restores the canonical
thread's persisted model and provider. A separate native Codex control can
change that persisted pair, and the initial snapshot can produce Codex's normal
model-difference warning; the outer OpenClaw model and fallback chain never
substitute for either.

## Supervision and safe continuation

Codex supervision is an opt-in capability of the same `codex` plugin. It discovers
native threads through a separate connection and projects only non-archived
sessions into the Gateway catalog. Without explicit `appServer` connection
settings, that connection uses managed user-home stdio while the ordinary
harness remains agent-scoped. Listing and metadata reads are passive: they do
not resume a thread, subscribe OpenClaw to its live events, or answer its
approvals.

For a stored or idle session on the Gateway computer, **Continue as branch**
creates a normal, model-locked Chat and mirrors bounded user and assistant
history through the source's last terminal persisted turn. The first normal
Chat turn installs the real approval handlers and uses an ephemeral native fork
to pin the snapshot without a model or provider override. Codex App Server uses
its current native configuration and returns the selected pair; it emits its
normal warning if that model differs from the source's last recorded model.
OpenClaw confirms the fork's subscription is released before starting the canonical
`appServer`-source Codex harness thread under its cwd and runtime policy with
exactly the returned model and provider for that initial start. It then injects the
bounded visible history and commits the binding on the same supervision connection.
The probe is never persisted or archived. The source is never
resumed. The canonical thread has the full OpenClaw harness tool surface;
reasoning, tool calls, and tool results from the source are not cloned into it.
The private connection scope survives pending and committed binding states, so
every later turn remains on that connection with native auth and provider
configuration. Disabled supervision or binding/connection drift fails closed
rather than switching to the ordinary agent-home harness.

The original CLI, VS Code, Atlas, or ChatGPT source remains eligible for both
catalogs. The canonical branch is a native Codex thread, but its source kind is
`appServer`; native clients may filter that source kind, so its appearance in
Codex Desktop is not guaranteed.

Active sources cannot start a new branch or be archived; an existing supervised
Chat can still be opened. `notLoaded` means activity is unknown, not idle;
OpenClaw allows archive for a local `idle` or `notLoaded` row only after explicit
no-other-runner confirmation and a fresh process-local status read. Codex
serializes thread mutations within one App Server process but does not provide
an exclusive cross-process runner or approval-owner lease, so that read cannot
prove that another process is not using the thread. OpenClaw blocks a known
active binding owner for the exact target or any non-archived spawned descendant
returned by Codex's paginated descendant query. Enumeration errors, cycles, and
safety-limit exhaustion fail closed. Native archive can still race a new turn
in another process, so confirmation covers unknown clients and the gap between
status read and archive. A supervised model-locked Chat cannot be deleted while
it protects the native binding.

Paired-node catalogs expose bounded, paginated transcripts. Eligible stored or
idle rows can also create or reopen a model-locked Chat when the connected node
advertises and permits the catalog list, transcript read, and
`codex.cli.session.resume` commands, and the operator has `operator.admin`.
Later messages resume the exact native thread through the node's Codex CLI and
return its final text; this is not the Gateway-local branch flow or a streaming
App Server harness bridge. Nodes without those capabilities remain readable
without continuation, and paired-node archive remains unavailable. See
[paired-node limits](/plugins/codex-supervision#understand-paired-node-limits).

See [Codex supervision](/plugins/codex-supervision) for operator setup and the
visible Control UI behavior.
