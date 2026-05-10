---
summary: "OpenClaw tools, skills, and plugins overview: what agents can call and how to extend them"
read_when:
  - You want to understand what tools OpenClaw provides
  - You are deciding between built-in tools, skills, and plugins
  - You need the right docs entry point for tool policy, automation, or agent coordination
title: "Tools, skills, and plugins"
---

OpenClaw agents use **tools** to act, **skills** to learn how to act, and
**plugins** to add new capabilities. Use this page as the map for choosing the
right surface.

## Choose the right surface

| You want to                                        | Start here                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| See what agents can call                           | [Built-in tool categories](#built-in-tool-categories)                        |
| Allow, deny, or profile tools                      | [Tools and custom providers](/gateway/config-tools)                          |
| Configure command approvals or elevated access     | [Exec approvals](/tools/exec-approvals) and [Elevated exec](/tools/elevated) |
| Install or manage plugins                          | [Plugins](/tools/plugin)                                                     |
| Build a plugin capability                          | [Build plugins](/plugins/building-plugins)                                   |
| Add or tune skills                                 | [Skills](/tools/skills) and [Creating skills](/tools/creating-skills)        |
| Schedule or track background work                  | [Automation](/automation)                                                    |
| Coordinate sub-agents or external harness sessions | [Sub-agents](/tools/subagents) and [ACP agents](/tools/acp-agents)           |

## Tools, skills, and plugins

OpenClaw has three layers that work together:

<Steps>
  <Step title="Tools are what the agent calls">
    A tool is a typed function the agent can invoke, such as `exec`,
    `browser`, `web_search`, `message`, or `image_generate`. OpenClaw ships
    built-in tools, and plugins can register more.

    The model receives tools as structured function definitions.

  </Step>

  <Step title="Skills teach the agent when and how">
    A skill is a `SKILL.md` instruction pack loaded into the agent prompt.
    Skills teach workflows, constraints, and good operating habits around tools.
    They can live in a workspace, shared skill directory, managed OpenClaw skill
    root, or plugin package.

    [Skills reference](/tools/skills) | [Creating skills](/tools/creating-skills)

  </Step>

  <Step title="Plugins package capabilities">
    A plugin can provide tools, skills, channels, model providers, speech,
    realtime voice, media generation, web search, web fetch, hooks, and other
    runtime capabilities. Some plugins ship with OpenClaw, and external plugins
    can be installed from ClawHub, npm, git, local directories, or archives.

    [Install and configure plugins](/tools/plugin) | [Build your own](/plugins/building-plugins)

  </Step>
</Steps>

## Built-in tool categories

These categories are available without installing external plugins. The exact
tool list still depends on the active tool profile, allow/deny policy, provider
restrictions, sandbox mode, and channel permissions.

| Category            | Common tools                                                         | What they do                                                              | More                                                                   |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Runtime             | `exec`, `process`, `code_execution`                                  | Run commands, manage processes, or use provider-backed Python analysis    | [Exec](/tools/exec), [Code execution](/tools/code-execution)           |
| Files               | `read`, `write`, `edit`, `apply_patch`                               | Read and change workspace files                                           | [Apply patch](/tools/apply-patch)                                      |
| Web                 | `web_search`, `x_search`, `web_fetch`                                | Search the web, search X posts, and fetch readable page content           | [Web tools](/tools/web), [Web fetch](/tools/web-fetch)                 |
| Browser             | `browser`                                                            | Drive a Chromium browser for navigation, clicking, forms, and screenshots | [Browser](/tools/browser)                                              |
| Messaging           | `message`                                                            | Send replies and channel actions across connected messaging surfaces      | [Agent send](/tools/agent-send)                                        |
| Sessions and agents | `sessions_*`, `subagents`, `agents_list`, `session_status`           | Inspect sessions, delegate work, steer runs, and report status            | [Sub-agents](/tools/subagents), [Session tool](/concepts/session-tool) |
| Automation          | `cron`, `heartbeat_respond`                                          | Schedule and respond to background work                                   | [Automation](/automation)                                              |
| Gateway and nodes   | `gateway`, `nodes`                                                   | Inspect or update the Gateway and target paired devices                   | [Gateway configuration](/gateway/configuration), [Nodes](/nodes)       |
| Media               | `image`, `image_generate`, `music_generate`, `video_generate`, `tts` | Analyze, generate, or speak media                                         | [Media overview](/tools/media-overview)                                |

For policy and configuration details, use [Tools and custom providers](/gateway/config-tools). That page is the canonical reference for tool profiles, tool groups, allow/deny lists, provider-specific restrictions, loop detection, and provider-backed tool settings.

## Plugin-provided tools

Plugins can register additional tools with `api.registerTool(...)` and declare
them in the plugin manifest's `contracts.tools` list. OpenClaw captures the
validated descriptor during discovery so tool planning can use cached metadata;
tool execution still loads the owning plugin and calls the live implementation.

Common plugin-provided tools include:

- [Diffs](/tools/diffs) for rendering file and markdown diffs
- [LLM Task](/tools/llm-task) for JSON-only workflow steps
- [Lobster](/tools/lobster) for typed workflows with resumable approvals
- [Tokenjuice](/tools/tokenjuice) for compacting noisy tool output
- [Tool Search](/tools/tool-search) for searching and calling large tool catalogs without putting every schema in the prompt
- [Canvas](/plugins/reference/canvas) for node Canvas control and A2UI rendering

## Tool policy

Tool policy is enforced before the model call. A run can lose tools because of
global config, per-agent config, channel policy, provider restrictions, sandbox
rules, owner-only gating, or plugin availability.

Use these references when you need to change policy rather than just understand
the available surfaces:

- [Tools and custom providers](/gateway/config-tools) for `tools.*` profiles,
  groups, allow/deny lists, loop detection, and provider-backed tool settings
- [Exec approvals](/tools/exec-approvals) for host command approval policy
- [Elevated exec](/tools/elevated) for controlled access outside sandboxed runs
- [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for how sandboxing and tool policy differ
- [Per-agent sandbox and tool restrictions](/tools/multi-agent-sandbox-tools) for sub-agent and agent-specific restrictions

## Related

- [Automation](/automation) for cron, tasks, heartbeat, commitments, hooks, standing orders, and Task Flow
- [Agents](/concepts/agent) for the agent model, sessions, memory, and multi-agent coordination
- [Plugins](/tools/plugin) for plugin installation and management
- [Plugin SDK](/plugins/sdk-overview) for plugin author reference
- [Skills](/tools/skills) for skill load order, gating, and config
