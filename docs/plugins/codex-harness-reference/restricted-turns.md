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
the harness applies the named OpenClaw denial directly. Any other deny fails
closed into the restricted surface. For example, `tools.deny: ["nodes"]`
restricts the native surface because `nodes` is not in the audited set.

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
