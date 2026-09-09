---
summary: "Tool profiles, groups, sandbox tool gates, code mode, and allow/deny policy layers"
read_when:
  - Choosing a tool profile or expanding it with `tools.allow`
  - Deciding which tools a provider, sender, or sandboxed session may call
  - Enabling code mode or elevated exec
title: "Configuration — tool policy"
---

The policy layers that decide which tools a run may call: `tools.profile`, tool groups, the sandbox tool gate, `tools.codeMode`, and the `allow`/`deny` surfaces evaluated on top of them.

## Tool profiles

`tools.profile` sets a base allowlist before `tools.allow`/`tools.deny`:

<Note>
Local onboarding defaults new local configs to `tools.profile: "coding"` when unset (existing explicit profiles are preserved).
</Note>

| Profile     | Includes                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal`   | `session_status` only                                                                                                                                                                                                                                   |
| `coding`    | `group:fs`, `group:runtime`, `group:web`, `group:sessions`, `group:memory`, `cron`, `get_goal`, `create_goal`, `update_goal`, `progress_card`, `ask_user`, `skill_workshop`, `view_image`, `image_generate`, `music_generate`, `video_generate`         |
| `messaging` | `group:messaging`, `sessions`, `sessions_list`, `sessions_history`, `sessions_search`, `conversations_list`, `conversations_send`, `conversations_turn`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`, `ask_user` |
| `full`      | No restriction (same as unset)                                                                                                                                                                                                                          |

`coding` and `messaging` also implicitly allow `bundle-mcp` (configured MCP servers).

## Tool groups

| Group              | Tools                                                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group:runtime`    | `exec`, `process`, `code_execution` (`bash` is accepted as an alias for `exec`)                                                                                                                                                                          |
| `group:fs`         | `read`, `write`, `edit`, `apply_patch`                                                                                                                                                                                                                   |
| `group:sessions`   | `sessions`, `sessions_list`, `sessions_history`, `sessions_search`, `conversations_list`, `conversations_send`, `conversations_turn`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`, `suggest_task`, `dismiss_task` |
| `group:memory`     | `memory_search`, `memory_get`                                                                                                                                                                                                                            |
| `group:web`        | `web_search`, `x_search`, `web_fetch`                                                                                                                                                                                                                    |
| `group:ui`         | `browser`, `screen`, `dashboard`, `terminal`, `portal`, `canvas`, `show_widget`                                                                                                                                                                          |
| `group:automation` | `heartbeat_respond`, `cron`, `gateway`                                                                                                                                                                                                                   |
| `group:messaging`  | `message`                                                                                                                                                                                                                                                |
| `group:nodes`      | `nodes`, `computer`                                                                                                                                                                                                                                      |
| `group:agents`     | `agents_list`, `get_goal`, `create_goal`, `update_goal`, `progress_card`, `ask_user`, `skill_workshop`                                                                                                                                                   |
| `group:media`      | `view_image`, `image_generate`, `music_generate`, `video_generate`, `tts`                                                                                                                                                                                |
| `group:openclaw`   | All built-in tools above except `read`/`write`/`edit`/`apply_patch`/`exec`/`process`/`canvas` (excludes plugin tools)                                                                                                                                    |
| `group:plugins`    | Tools owned by loaded plugins, including configured MCP servers exposed through `bundle-mcp`                                                                                                                                                             |

`suggest_task` lets an agent propose confirmed follow-up work without starting it. The working directory must be absolute, but does not need to be a Git checkout. Local debugging and non-code tasks are supported. The Control UI shows the title and summary as an actionable chip; a Gateway-backed TUI shows an equivalent interactive prompt. **Start in a new session** opens a normal session in that directory and sends the full task prompt. The new session is instructed to ask the user before creating or switching to a worktree if isolation becomes necessary. There is no up-front worktree or execution-destination choice. `dismiss_task` withdraws a still-pending suggestion by the ephemeral `task_id` returned from `suggest_task`.

The tools are offered only when the initiating operator surface can receive and action Gateway task-suggestion events. Channel sessions and local/embedded TUI sessions do not receive them; channel transports need a portable typed task action before they can safely expose this flow. Suggestions are process-local and disappear when the Gateway restarts. Both tools remain in the `coding` profile and `group:sessions`, so normal `tools.allow` and `tools.deny` policy configures them automatically when the surface supports them.

## MCP and plugin tools inside sandbox tool policy

Configured MCP servers are exposed as plugin-owned tools under the `bundle-mcp` plugin id. Normal tool profiles can allow them, but `tools.sandbox.tools` is an additional gate for sandboxed sessions. If sandbox mode is `"all"` or `"non-main"`, include one of these entries in the sandbox tool allowlist when MCP/plugin tools should be visible:

- `bundle-mcp` for OpenClaw-managed MCP servers from `mcp.servers`
- the plugin id for a specific native plugin
- `group:plugins` for all loaded plugin-owned tools
- exact MCP server tool names or server globs such as `outlook__send_mail` or `outlook__*` when you only want one server

Server globs use the provider-safe MCP server prefix, not necessarily the raw `mcp.servers` key. Non-`[A-Za-z0-9_-]` characters become `-`, names that do not start with a letter get an `mcp-` prefix, and long or duplicate prefixes may be truncated or suffixed; for example, `mcp.servers["Outlook Graph"]` uses a glob like `outlook-graph__*`.

Per-run `toolsAllow` caps also accept globs such as `outlook*` or `out*graph*` for configured MCP servers. These globs can trigger catalog discovery across all enabled static MCP servers, just like `outlook__*`; they do not limit which servers connect. Discovery is conservative and can run even when no tool ultimately matches. Final tool allow/deny and sandbox policies still apply, disabled servers remain excluded unless explicitly enabled by a session override, and requester-scoped servers still require their verified requester context.

```json5
{
  agents: { defaults: { sandbox: { mode: "all" } } },
  mcp: {
    servers: {
      outlook: { command: "node", args: ["./outlook-mcp.js"] },
    },
  },
  tools: {
    sandbox: {
      tools: {
        alsoAllow: ["web_search", "web_fetch", "memory_search", "memory_get", "bundle-mcp"],
      },
    },
  },
}
```

Without that sandbox-layer entry, the MCP server can still load successfully while its tools are filtered before the provider request. Use `openclaw doctor` to catch this shape for OpenClaw-managed servers in `mcp.servers`. MCP servers loaded from bundled plugin manifests or Claude `.mcp.json` use the same sandbox gate, but this diagnostic does not enumerate those sources yet; use the same allowlist entries if their tools disappear in sandboxed turns.

## `tools.codeMode`

`tools.codeMode` gates the generic OpenClaw code-mode surface. When engaged
for a run with tools, normal OpenClaw tools move behind the in-sandbox `tools.*`
catalog bridge, and MCP tools are available through the generated `MCP`
namespace. The model normally sees `exec` and `wait`; tools such as `computer`
whose structured results cannot cross the JSON-only bridge stay direct.

`enabled` defaults to `false`, including when the object sets other Code Mode
options. To engage code mode only for models whose catalog entry flags
`compat.codeMode: "preferred"`, enable `"auto"` explicitly. See
[Code Mode - automatic per-model activation](/tools/code-mode/configuration#automatic-per-model-activation).

```json5
{
  tools: {
    codeMode: {
      enabled: "auto",
    },
  },
}
```

The shorthand is also accepted:

```json5
{
  tools: { codeMode: "auto" },
}
```

`enabled: true` forces code mode on for every tool-capable run, regardless of
model.

MCP declarations are exposed through the read-only virtual API file surface in
code mode. Guest code can call `API.list("mcp")` and
`API.read("mcp/<server>.d.ts")` to inspect TypeScript-style signatures before
calling `MCP.<server>.<tool>()`. See [Code Mode](/tools/code-mode) for the
runtime contract, limits, and debugging steps.

## `tools.allow` / `tools.deny`

Global tool allow/deny policy (deny wins). Case-insensitive, supports `*` wildcards. Applied even when Docker sandbox is off.

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

`write` and `apply_patch` are separate tool ids. `allow: ["write"]` also enables `apply_patch` for compatible models, but `deny: ["write"]` does not deny `apply_patch`. To block all file mutation, deny `group:fs` or list each mutating tool explicitly:

```json5
{
  tools: { deny: ["write", "edit", "apply_patch"] },
}
```

<Note>
`allow` and `alsoAllow` cannot both be set in the same scope (`tools`, `tools.byProvider.<id>`, `agents.entries.*.tools`) — config validation rejects it. Merge `alsoAllow` entries into `allow`, or drop `allow` and use `profile` + `alsoAllow` instead.
</Note>

The image inspection tool is `view_image`. If an older config still names
`image` in an allow, `alsoAllow`, or deny list, run `openclaw doctor --fix` to
rewrite supported global, per-agent, provider, sandbox, sender, channel, and
Gateway policy surfaces. Doctor preserves patterns such as `image*` that may
still match other tools and adds `view_image` when the pattern no longer covers
inspection. Patterns that already cover both names, such as `*` or `*image*`,
remain unchanged.

## `tools.byProvider`

Further restrict tools for specific providers or models. Order: base profile → provider profile → allow/deny.

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      anthropic: { profile: "minimal" },
      "openai/gpt-5.4": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

## `tools.toolsBySender`

Restricts tools for the current turn's originating requester. This is defense-in-depth on top of channel access control; sender values must come from the channel adapter, not message text. It does not authenticate other content in the model prompt; see [Requester-scoped controls and prompt context](/gateway/security/hardened-baseline#requester-scoped-controls-and-prompt-context).

```json5
{
  tools: {
    toolsBySender: {
      "channel:discord:1234567890123": { alsoAllow: ["group:fs"] },
      "id:guest-user-id": { deny: ["group:runtime", "group:fs"] },
      "*": { deny: ["exec", "process", "write", "edit", "apply_patch"] },
    },
  },
}
```

Keys use explicit prefixes: `channel:<channelId>:<senderId>`, `id:<senderId>`, `e164:<phone>`, `username:<handle>`, `name:<displayName>`, or `"*"`. Channel ids are canonical OpenClaw ids; aliases such as `teams` normalize to `msteams`. Legacy unprefixed keys are accepted as `id:` only. Matching order is channel+id, id, e164, username, name, then wildcard.

Per-agent `agents.entries.*.tools.toolsBySender` overrides the global sender match when it matches, even with an empty `{}` policy.

## `tools.elevated`

Controls elevated exec access outside the sandbox:

```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["1234567890123", "987654321098765432"],
      },
    },
  },
}
```

- Per-agent override (`agents.entries.*.tools.elevated`) can only further restrict.
- `/elevated on|off|ask|full` stores state per session; inline directives apply to single message.
- Elevated `exec` bypasses sandboxing and uses the configured escape path (`gateway` by default, or `node` when the exec target is `node`).
