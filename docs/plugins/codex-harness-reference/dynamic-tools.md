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
toward native `spawn_agent` for work using native tools or explicitly delegated
host tools. Work that needs other OpenClaw tools uses the available `sessions_spawn` route with
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

For supported checks before inference, see
[Codex pre-turn verification](/plugins/codex-harness/commands#verify-tool-access-before-a-codex-turn).

## Native child host tools

By default, a native Codex child cannot execute OpenClaw dynamic tools. To
delegate selected host capabilities, set `plugins.entries.codex.config.nativeChildTools`:

```json
{
  "allow": ["search_notes", "research__*"],
  "deny": ["research__delete_*"]
}
```

Use the exposed tool name, not the Codex discovery prefix (`openclaw.`).
In this example `research` is an OpenClaw-projected MCP server. An empty or
absent `allow` grants nothing; `deny` takes precedence. Patterns match the
whole tool name. `*` matches zero or more characters, including `__`: for
example, `research__get_*` matches both `research__get_` and
`research__get_team__doc`. The wildcard also matches future eligible tools with those
names. Prefer exact names when you need to review new capabilities individually.

Both lists use OpenClaw's tool-policy aliases. The matcher trims and lowercases
both the pattern and the tool name, then replaces whole-name aliases:
`bash` to `exec`, `apply-patch` to `apply_patch`, `cron` to `automations`, and
`tool_call` to `dispatch_action`. For example, an allow or deny entry of `exec`
also matches an eligible plugin tool literally named `bash`. Matching does
not make the built-in `exec` eligible or change Codex-native shell access.

These calls use **OpenClaw host authority**. A child's native Codex sandbox and
approval settings do not confine them. Host-side availability, tool and action
policies and approvals still apply; an inherited tool schema is not a grant.
Parent-session controls and reply delivery do not run on behalf of a child.
An admitted child can keep using its granted tools after the foreground turn
ends. Its MCP calls can return data, but cannot open an MCP form or App preview
in the parent's session. Normal host-side tool approvals still apply.
Execution requires a direct child on a host-owned stdio app-server connection
and a retained requester identity. Shared WebSocket and Unix transports do
not establish exclusive dispatch ownership. A system turn cannot borrow an
operator's identity.
The grant does not change native coding tools, delegation, or MCP tools run
directly by Codex. Use the normal Gateway restart or replacement procedure
when changing deployment policy.

To preview the selection, enable debug logging and inspect the
`codex native child tool catalog` record for the target run. It lists tool
names, ownership where known, selection decisions and unmatched patterns.
This is a snapshot of the parent bridge, not a promise of later availability:
calls still require an owned, active child and an eligible host binding.
The preview does not invoke tools.

### Eligible host tools

The following is the complete list of core tools you can grant to a direct
native child. A core tool is a tool ID in OpenClaw's built-in registry, even
if a plugin implements it. The tool must also be available to the parent
through the OpenClaw bridge.

- Files: `ls`, `read`, `write`, `edit`, `apply_patch`.
- Skills and memory: `skills_read`, `skills_search`, `memory_search`, `memory_get`.
- Web: `web_search`, `web_fetch`, `x_search`.
- Documents and images: `pdf`, `view_image`.
- Media generation: `image_generate`, `video_generate`, `music_generate`.

All other core tools, including new ones, remain unsupported until OpenClaw
adds child support for them. Neither an exact allow entry nor `allow: ["*"]`
overrides this limit.

For example, `allow: ["image_generate"]` lets a child generate an image, but
does not grant music or video generation. A delegated generator returns the
artifact path or provider URL to the child. It does not queue a chat job or
send the media to the parent's conversation. The caller can pass the artifact
reference back to the parent, which decides whether to send it. Image review
and delivery actions require a chat session and are unavailable to the child.
Provider costs, tool timeouts, and workspace restrictions still apply. Calling
the same tools directly in the parent chat keeps their usual delivery behavior.

Non-core tools can qualify when OpenClaw identifies their owning plugin or MCP
server. OpenClaw excludes tools it recognizes as channel messaging tools.
Three tools owned by the Codex plugin are also always excluded:
`codex_session_send`, `codex_session_interrupt`, and `codex_threads`. They can
control sessions outside the child's assignment. Neither an exact allow entry
nor `codex_*` or `*` grants them. This exclusion does not change parent access.
There is no fixed list of eligible plugin tools: use the catalog preview above
to see which tools your parent session can delegate. Eligibility alone never
grants access.

## Protected conversation continuity

While native work protects a thread, OpenClaw retains its accepted tool declarations.
Those declarations do not grant execution: current tools and fallback executors must
still match the accepted description and canonical JSON schema after preparation.
Changing object-key order is compatible; changing the declaration is not. Invalid
saved catalog receipts stop reuse without replacing the thread or repairing its receipt.

Inbound and private-completion producers identify their exact transient conversation
context within `extraSystemPrompt`. Codex delivers the complete current snapshot,
together with current tool bindings, through the existing parent-local inference
and native developer-handoff paths. Managed inference receives it on every admitted
parent request, including immediate post-compaction continuation; native
additional-context deduplication is not used.

Without a parent-local inference relay, OpenClaw also keeps the initial conversation
snapshot in creation policy because native compaction can discard injected history
before the host can refresh it. Reused threads receive a full handoff before each
turn and after compaction, but a protected thread still refuses a changed creation
snapshot instead of replacing or borrowing that thread. As with the existing native
refresh handoff, an immediate native continuation can precede the host callback and
therefore lack fresh turn context. No new durable cache is added.
Configured conversation policy, execution hints, and caller-added instructions
remain part of persistent thread identity. Invalid or stale annotations leave the
full prompt persistent. Other harnesses still receive the complete prompt unchanged.
