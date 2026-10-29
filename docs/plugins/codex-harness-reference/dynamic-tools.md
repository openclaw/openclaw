---
summary: "How OpenClaw dynamic tools are exposed to Codex app-server turns"
read_when:
  - You need to know which OpenClaw tools Codex can call
  - You are changing dynamic tool loading or exclusions
  - You are debugging the Codex tool payload
title: "Codex dynamic tools"
sidebarTitle: "Dynamic tools"
---

Which OpenClaw dynamic tools reach a Codex turn, and how they are loaded. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## Dynamic tools

Codex dynamic tools default to `searchable` loading, exposed under the
`openclaw` namespace with `deferLoading: true`. OpenClaw normally does not
expose dynamic tools that duplicate Codex-native workspace operations or
Codex's own tool-search surface:

- `read`
- `write`
- `edit`
- `apply_patch`
- `exec`
- `process`
- `dispatch_action`
- `tool_describe`
- `tool_search`

`progress_card` is not filtered with those native workspace tools. It remains
available through the OpenClaw dynamic-tool bridge as the durable session status
surface.

When a finite runtime allowlist disables native Code Mode, OpenClaw sends an
empty execution-environment selection. In that direct, unsandboxed case,
OpenClaw keeps its policy-filtered `exec` and `process` tools as the shell
fallback. Runtime allowlists and `codexDynamicToolsExclude` still apply.

Most remaining OpenClaw integration tools, such as messaging, media, cron,
browser, nodes, gateway, `heartbeat_respond`, and `web_search`, are available
through Codex tool search under that namespace. This keeps the initial model
context smaller. A small set of tools stay directly callable regardless of
`codexDynamicToolsLoading`, because Codex tool search can be unavailable or
resolve a connector-only universe: `agents_list`, `sessions_spawn`, and
`sessions_yield`. Developer instructions still steer normal Codex subagents
toward native `spawn_agent` for Codex-native subagent work, while
`sessions_spawn` remains available for explicit OpenClaw or ACP delegation.
Message-tool-only source replies also stay direct, since that is a
turn-control contract.

Codex Code Mode projects generic OpenClaw dynamic-tool results as text. Parse a
JSON result before reading fields. Nested dynamic calls are serialized by the
Codex runtime, so `Promise.all` does not submit them concurrently; use a
bounded sequential launch loop when starting collector children.

Tools marked `catalogMode: "direct-only"`, including the OpenClaw `computer`
tool and regular-agent `openclaw` delegation, are grouped under `openclaw_direct`.
OpenClaw adds that namespace to Codex's
`features.code_mode.direct_only_tool_namespaces` list without replacing
operator-supplied entries. Codex therefore exposes those tools as
`DirectModelOnly` in normal and code-mode-only threads instead of routing them
through nested Code Mode `tools.*` calls. This preserves image-bearing results,
which nested Code Mode otherwise flattens to text. It also keeps delegated human
approval on the direct model call: a yielded script cell must not let the model
finish its turn while that approval is still waiting.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom
Codex app-server that cannot search deferred dynamic tools or when debugging
the full tool payload.

## Protected conversation continuity

While native work protects a thread, OpenClaw retains its accepted tool declarations.
Those declarations do not grant execution: current tools must still match the
accepted description and canonical JSON schema after preparation. Registered
fallback executors are not used to recover protected declarations.
Changing object-key order is compatible; changing the declaration is not. Invalid
saved catalog receipts stop reuse without replacing the thread or repairing its receipt.

Inbound and private-completion producers identify their exact transient conversation
context within `extraSystemPrompt`. Codex delivers the complete current snapshot,
together with current tool bindings, through the existing parent-local inference
relay. Managed inference receives it on every admitted parent request, including
immediate post-compaction continuation.

Without a parent-local inference relay, OpenClaw also keeps the initial conversation
snapshot in creation policy. A protected thread refuses a changed creation snapshot
instead of replacing or borrowing that thread. This baseline does not add a native
per-turn developer handoff without the relay, so native compaction can discard
conversation context before the host can refresh it. No new durable cache is added.
Configured conversation policy, execution hints, and caller-added instructions
remain part of persistent thread identity. Invalid or stale annotations leave the
full prompt persistent. Other harnesses still receive the complete prompt unchanged.

Protected continuations carrying producer-annotated conversation context require
a current parent-local inference relay even when conversation bytes are unchanged.
Without that carrier, OpenClaw rejects before
native turn dispatch and preserves active native work. This avoids relying on
native compaction to retain instructions. Ordinary idle no-relay turns continue
to use native creation/resume instructions and retain their existing compaction
limitation; they do not gain authority from a saved catalog or prompt.
