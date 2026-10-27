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

When the native surface is disabled, OpenClaw publishes allowed dynamic tools
directly instead of requiring unavailable native discovery. This includes managed
GitHub identity and sandbox-backed execution. Native-enabled threads retain
searchable, direct, and code-mode-only loading. In native JavaScript `exec`,
`ALL_TOOLS` and `tools` are JavaScript globals, never shell environment variables.
OpenClaw shell tools execute operating-system commands.

When a finite runtime allowlist disables native Code Mode, OpenClaw sends an
empty execution-environment selection. In that direct, unsandboxed case,
OpenClaw keeps its policy-filtered `exec` and `process` tools as the shell
fallback. Runtime allowlists and `codexDynamicToolsExclude` still apply.

`tools.gatewayPolicy` adds a required allowlist for Gateway-supplied tools and
their actions. The adapter applies it after tool additions and exclusions, to
both declarations and executable callbacks. It does not restrict Codex-native
coding tools or subagents. Existing ordinary restrictions and
`codexDynamicToolsExclude` can narrow access further.

Callbacks check the deployment policy captured when their tools are constructed,
including calls from restored threads. Policy changes require a Gateway restart
or replacement after affected old work ends. Reconstructed callbacks use the new
policy; saved native declarations retain their fingerprint, so a previously
advertised tool can return a policy denial. Direct human Gateway administration
keeps its existing permissions.

While native children protect a managed parent thread, OpenClaw retains the
declarations accepted by that thread. Each turn still uses fresh executable
bindings and current authority; removed tools and changed definitions remain
unavailable until the thread can accept new declarations. Conversation context
travels through the existing parent-local inference relay on each request, while
configured policy stays in the native thread. Connections without that relay
retain their existing creation-policy checks.

Most remaining OpenClaw integration tools, such as messaging, media, cron,
browser, nodes, gateway, and `web_search`, are available
through Codex tool search under that namespace. This keeps the initial model
context smaller. A small set of tools stay directly callable regardless of
`codexDynamicToolsLoading`, because Codex tool search can be unavailable or
resolve a connector-only universe: `agents_list`, `sessions_spawn`, and
`sessions_yield`. Developer instructions still steer normal Codex subagents
toward native `spawn_agent` for work using only Codex-native tools. New delegated
work that needs OpenClaw tools uses the available `sessions_spawn` route with
`runtime="subagent"` when its schema exposes that selector. Native children can
inherit dynamic tool schemas without an OpenClaw executor. Existing native
children keep their native follow-up path; tool failures do not migrate them
to managed workers. Explicit ACP delegation still uses `sessions_spawn`.
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
