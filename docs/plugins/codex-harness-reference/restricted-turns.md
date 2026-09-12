---
summary: "When a tool policy restricts the Codex native surface, and what ring zero adds"
read_when:
  - You are setting a tool allow or deny policy for Codex
  - You need the audited safe-deny tool names
  - You are debugging a turn with no native Code Mode
title: "Codex restricted turns"
sidebarTitle: "Restricted turns"
---

Which tool policies push a Codex turn onto the restricted native surface. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## Restricted turns

The Codex harness evaluates the effective tool policy for every turn. It marks
the turn policy-restricted when any explicit policy would otherwise leave a
Codex-native capability outside the OpenClaw policy boundary.

Restriction sources include global, provider, agent, group, sender, sandbox,
subagent, inherited, scheduled/runtime, and per-run tool policies. A finite
allowlist always restricts the native surface. A deny list restricts it when an
expanded entry is unknown or absent from the audited safe-deny set; this includes
wildcards and tool groups containing any unsafe entry. `disableTools` becomes an
empty per-run allowlist and therefore also restricts the native surface. Default
tool-profile narrowing is not an explicit restriction and does not activate this
mode.

The current audited safe-deny names are:

```text
automations, canvas, dashboard, gateway, heartbeat_respond, image_generate,
memory_get, memory_search, message, music_generate, show_widget, skill_workshop,
tts, video_generate, web_fetch, x_search
```

A policy containing only those denies stays on the normal Codex native surface;
the harness applies the named OpenClaw denial directly. Whole-server denies of
configured MCP, written as `<server>__*` for a static `mcp.servers` entry, also
stay native: the harness omits that server from its `mcp_servers` projection,
the same override `codex.agents` scoping uses, applies the same exclusion to
the configured-MCP preflight and the dynamic materializer, and sends
`mcp_servers.<server>.enabled = false` when the agent's native Codex config
defines a server of the same name. A `<server>__*` pattern that could name two
configured servers (one server's raw key normalizing onto another's sanitized
name) is not accepted and still restricts the surface. Whole-app denies of
Codex Apps, written as `mcp__codex_apps__<app>_*` where `<app>` is the
namespace Codex derives from the app's connector name (for example
`mcp__codex_apps__gamma_*` for tools like
`mcp__codex_apps__gamma_list_items`), also stay native: the harness rebuilds
the model-visible names from the `codex_apps` inventory in `mcpServerStatus/list`
using Codex's own naming rules and leaves a fully covered app out of the
thread's `apps` patch. The `<app>_*` form denies the whole app by its
namespace, so it also covers a tool whose callable name carries no separator
(a raw `capture_file_upload` under a `Gmail` connector is exposed as
`mcp__codex_apps__gmailcapture_file_upload`). Tools an app hides from the
model through `_meta.ui.visibility` are ignored, as Codex ignores them.
`mcp__codex_apps__*` denies every app, including one whose tools carry no
connector name and so cannot be addressed by an `<app>_*` form. An app-shaped deny that could also reach
a configured MCP server's tools (a server named `codex_apps` or
`codex_apps__<anything>`) still restricts the surface, because the app
projection cannot remove that server's tools; a server of that shape defined
only in the agent's native Codex config is switched off on the thread instead.
A pattern that
matches only some of one app's tools, a pattern that matches no app at all, an
unreadable inventory, or a `codexPlugins` block that is absent or disabled
cannot be projected, so that turn runs with all Codex apps disabled and an
`app_policy_unenforceable` diagnostic. Any other deny fails
closed into the restricted surface, which also disables account-connected
Codex Apps for the turn. For example, `tools.deny: ["nodes"]` restricts the native surface because
`nodes` is not in the audited set, and `tools.deny: ["<server>__get_*"]`
restricts it because Codex accepts only exact MCP tool names.

Policy-restricted turns have no Codex environment selection or native Code Mode.
OpenClaw disables inherited and configured MCP servers, attests that they remain
disabled, disables native hook relays, and applies the effective policy to its
dynamic tools. A temporary restriction on an existing session uses a transient
Codex thread and preserves the unrestricted binding for later resume.

Ring zero is not a configurable policy profile. It is the host-scoped system
agent path used by OpenClaw setup and repair flows. The host must activate the
system-agent authority and provide the exact single-tool allowlist
`["openclaw"]`. Ring zero applies the restricted tool surface plus host-authored
base instructions and zero project-document budget. It also suppresses
OpenClaw's `AGENTS.md` developer-instruction carrier, so ambient workspace
instructions cannot enter the setup/repair turn.

Message-only source replies also use the restricted tool surface. Lightweight
bootstrap turns and tool-disabled internal turns additionally set the project-
document budget to zero. These modes are separate inputs even when their final
thread configuration overlaps.
