---
summary: "Index of the OpenClaw ACP agents documentation, one page per reader job"
read_when:
  - Running coding harnesses through ACP
  - Setting up conversation-bound ACP sessions on messaging channels
  - Binding a message-channel conversation to a persistent ACP session
  - Troubleshooting ACP backend, plugin wiring, or completion delivery
  - Operating /acp commands from chat
  - You are looking for the ACP agents page that matches your task
title: "ACP agents"
sidebarTitle: "ACP agents"
---

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) sessions let
OpenClaw run external coding harnesses (Claude Code, Cursor, Copilot, Droid,
OpenClaw ACP, OpenCode, Gemini CLI, and other supported ACPX harnesses)
through an ACP backend plugin. Each spawn is tracked as a
[background task](/automation/tasks).

<Note>
**ACP is the external-harness path, not the default Codex path.** The native
Codex app-server plugin owns `/codex ...` controls and the default
`openai/gpt-*` embedded runtime for agent turns; ACP owns `/acp ...` controls
and `sessions_spawn({ runtime: "acp" })` sessions.

To let Codex or Claude Code connect as an external MCP client directly to
existing OpenClaw channel conversations, use
[`openclaw mcp serve`](/cli/mcp) instead of ACP.
</Note>

## Which page do I want?

| You want to...                                                                                  | Use this                              | Notes                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bind or control Codex in the current conversation                                               | `/codex bind`, `/codex threads`       | Native Codex app-server path when the `codex` plugin is enabled: bound chat replies, image forwarding, model/fast/permissions, stop, and steer. ACP is an explicit fallback |
| Run Claude Code, Gemini CLI, explicit Codex ACP, or another external harness _through_ OpenClaw | This page                             | Chat-bound sessions, `/acp spawn`, `sessions_spawn({ runtime: "acp" })`, background tasks, runtime controls                                                                 |
| Expose an OpenClaw Gateway session _as_ an ACP server for an editor or client                   | [`openclaw acp`](/cli/acp)            | Bridge mode: an IDE/client speaks ACP to OpenClaw over stdio/WebSocket                                                                                                      |
| Reuse a local AI CLI as a text-only fallback model                                              | [CLI Backends](/gateway/cli-backends) | Not ACP: no OpenClaw tools, no ACP controls, no harness runtime                                                                                                             |

## ACP agents documentation pages

This page is an index. ACP agents is documented on seven pages, one per reader
job. Open the page that matches your task.

| Page                                                            | Read it when                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [ACP agents quickstart](/tools/acp-agents/quickstart)           | You are installing the ACP runtime plugin or choosing a harness target id. |
| [ACP agents operator runbook](/tools/acp-agents/runbook)        | You run `/acp` from chat and need the flow, lifecycle, and routing rules.  |
| [ACP agents bindings](/tools/acp-agents/bindings)               | You are binding a conversation, thread, or configured `bindings[]` entry.  |
| [ACP agents sessions](/tools/acp-agents/sessions)               | You need `sessions_spawn` parameters or the `--bind` and `--thread` modes. |
| [ACP agents delivery model](/tools/acp-agents/delivery)         | You are debugging completion delivery, resume, or the sandbox boundary.    |
| [ACP agents controls](/tools/acp-agents/controls)               | You need the `/acp` command reference and runtime option mapping.          |
| [ACP agents troubleshooting](/tools/acp-agents/troubleshooting) | You hit an ACP error message and need the likely cause and fix.            |

## ACP versus sub-agents

Use ACP when you want an external harness runtime. Use **native Codex
app-server** for Codex conversation binding/control when the `codex` plugin
is enabled. Use **sub-agents** when you want OpenClaw-native delegated runs.

| Area          | ACP session                           | Sub-agent run                      |
| ------------- | ------------------------------------- | ---------------------------------- |
| Runtime       | ACP backend plugin (for example acpx) | OpenClaw native sub-agent runtime  |
| Session key   | `agent:<agentId>:acp:<uuid>`          | `agent:<agentId>:subagent:<uuid>`  |
| Main commands | `/acp ...`                            | `/subagents ...`                   |
| Spawn tool    | `sessions_spawn` with `runtime:"acp"` | `sessions_spawn` (default runtime) |

See also [Sub-agents](/tools/subagents).

## How ACP runs Claude Code

For Claude Code through ACP, the stack is:

1. OpenClaw ACP session control plane.
2. Official `@openclaw/acpx` runtime plugin.
3. Claude ACP adapter.
4. Claude-side runtime/session machinery.

ACP Claude is a **harness session** with ACP controls, session resume,
background-task tracking, and optional conversation/thread binding.

CLI backends are separate text-only local fallback runtimes - see
[CLI Backends](/gateway/cli-backends).

For operators, the practical rule is:

- **Want `/acp spawn`, bindable sessions, runtime controls, or persistent harness work?** Use ACP.
- **Want simple local text fallback through the raw CLI?** Use CLI backends.

## acpx harness, plugin setup, and permissions

For acpx harness configuration (Claude Code / Codex / Gemini CLI aliases),
the plugin-tools and OpenClaw-tools MCP bridges, and ACP permission modes,
see [ACP agents - setup](/tools/acp-agents-setup).

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/tools/acp-agents#persistent-channel-bindings`
still resolves. Each entry points at the page that now holds the content.

- <a id="does-this-work-out-of-the-box%3F" /><a id="does-this-work-out-of-the-box" />[Does this work out of the box?](/tools/acp-agents/quickstart#does-this-work-out-of-the-box)
- <a id="first-run-gotchas" />[First-run gotchas](/tools/acp-agents/quickstart#first-run-gotchas)
- <a id="runtime-prerequisites" />[Runtime prerequisites](/tools/acp-agents/quickstart#runtime-prerequisites)
- <a id="supported-harness-targets" />[Supported harness targets](/tools/acp-agents/quickstart#supported-harness-targets)
- <a id="operator-runbook" />[Operator runbook](/tools/acp-agents/runbook#operator-runbook)
- <a id="spawn" />[Spawn](/tools/acp-agents/runbook#spawn)
- <a id="work" />[Work](/tools/acp-agents/runbook#work)
- <a id="check-state" />[Check state](/tools/acp-agents/runbook#check-state)
- <a id="tune" />[Tune](/tools/acp-agents/runbook#tune)
- <a id="steer" />[Steer](/tools/acp-agents/runbook#steer)
- <a id="stop" />[Stop](/tools/acp-agents/runbook#stop)
- <a id="lifecycle-details" />[Lifecycle details](/tools/acp-agents/runbook#lifecycle-details)
- <a id="native-codex-routing-rules" />[Native Codex routing rules](/tools/acp-agents/runbook#native-codex-routing-rules)
- <a id="model-provider-runtime-selection-cheat-sheet" />[Model / provider / runtime selection cheat sheet](/tools/acp-agents/runbook#model-provider-runtime-selection-cheat-sheet)
- <a id="acp-routing-natural-language-triggers" />[ACP-routing natural-language triggers](/tools/acp-agents/runbook#acp-routing-natural-language-triggers)
- <a id="bound-sessions" />[Bound sessions](/tools/acp-agents/bindings#bound-sessions)
- <a id="mental-model" />[Mental model](/tools/acp-agents/bindings#mental-model)
- <a id="current-conversation-binds" />[Current-conversation binds](/tools/acp-agents/bindings#current-conversation-binds)
- <a id="binding-rules-and-exclusivity" />[Binding rules and exclusivity](/tools/acp-agents/bindings#binding-rules-and-exclusivity)
- <a id="thread-bound-sessions" />[Thread-bound sessions](/tools/acp-agents/bindings#thread-bound-sessions)
- <a id="thread-supporting-channels" />[Thread-supporting channels](/tools/acp-agents/bindings#thread-supporting-channels)
- <a id="persistent-channel-bindings" />[Persistent channel bindings](/tools/acp-agents/bindings#persistent-channel-bindings)
- <a id="binding-model" />[Binding model](/tools/acp-agents/bindings#binding-model)
- <a id="param-bindings-type" />[`bindings[].type`](/tools/acp-agents/bindings#param-bindings-type)
- <a id="param-bindings-match" />[`bindings[].match`](/tools/acp-agents/bindings#param-bindings-match)
- <a id="param-bindings-agent-id" />[`bindings[].agentId`](/tools/acp-agents/bindings#param-bindings-agent-id)
- <a id="param-bindings-acp-mode" />[`bindings[].acp.mode`](/tools/acp-agents/bindings#param-bindings-acp-mode)
- <a id="param-bindings-acp-label" />[`bindings[].acp.label`](/tools/acp-agents/bindings#param-bindings-acp-label)
- <a id="param-bindings-acp-cwd" />[`bindings[].acp.cwd`](/tools/acp-agents/bindings#param-bindings-acp-cwd)
- <a id="param-bindings-acp-backend" />[`bindings[].acp.backend`](/tools/acp-agents/bindings#param-bindings-acp-backend)
- <a id="runtime-defaults-per-agent" />[Runtime defaults per agent](/tools/acp-agents/bindings#runtime-defaults-per-agent)
- <a id="example" />[Example](/tools/acp-agents/bindings#example)
- <a id="behavior" />[Behavior](/tools/acp-agents/bindings#behavior)
- <a id="start-acp-sessions" />[Start ACP sessions](/tools/acp-agents/sessions#start-acp-sessions)
- <a id="from-sessions_spawn" />[From `sessions_spawn`](/tools/acp-agents/sessions#from-sessions_spawn)
- <a id="from-%2Facp-command" />[From `/acp` command](/tools/acp-agents/sessions#from-%2Facp-command)
- <a id="sessions_spawn-parameters" />[`sessions_spawn` parameters](/tools/acp-agents/sessions#sessions_spawn-parameters)
- <a id="param-task" />[`task`](/tools/acp-agents/sessions#param-task)
- <a id="param-runtime" />[`runtime`](/tools/acp-agents/sessions#param-runtime)
- <a id="param-agent-id" />[`agentId`](/tools/acp-agents/sessions#param-agent-id)
- <a id="param-thread" />[`thread`](/tools/acp-agents/sessions#param-thread)
- <a id="param-mode" />[`mode`](/tools/acp-agents/sessions#param-mode)
- <a id="param-cwd" />[`cwd`](/tools/acp-agents/sessions#param-cwd)
- <a id="param-label" />[`label`](/tools/acp-agents/sessions#param-label)
- <a id="param-resume-session-id" />[`resumeSessionId`](/tools/acp-agents/sessions#param-resume-session-id)
- <a id="param-stream-to" />[`streamTo`](/tools/acp-agents/sessions#param-stream-to)
- <a id="param-model" />[`model`](/tools/acp-agents/sessions#param-model)
- <a id="param-thinking" />[`thinking`](/tools/acp-agents/sessions#param-thinking)
- <a id="spawn-bind-and-thread-modes" />[Spawn bind and thread modes](/tools/acp-agents/sessions#spawn-bind-and-thread-modes)
- <a id="bind-here%7Coff" />[`--bind here|off`](/tools/acp-agents/sessions#bind-here%7Coff)
- <a id="thread-auto%7Chere%7Coff" />[`--thread auto|here|off`](/tools/acp-agents/sessions#thread-auto%7Chere%7Coff)
- <a id="delivery-model" />[Delivery model](/tools/acp-agents/delivery#delivery-model)
- <a id="interactive-acp-sessions" />[Interactive ACP sessions](/tools/acp-agents/delivery#interactive-acp-sessions)
- <a id="parent-owned-one-shot-acp-sessions" />[Parent-owned one-shot ACP sessions](/tools/acp-agents/delivery#parent-owned-one-shot-acp-sessions)
- <a id="sessions-send-and-a2a-delivery" />[`sessions_send` and A2A delivery](/tools/acp-agents/delivery#sessions-send-and-a2a-delivery)
- <a id="resume-an-existing-session" />[Resume an existing session](/tools/acp-agents/delivery#resume-an-existing-session)
- <a id="post-deploy-smoke-test" />[Post-deploy smoke test](/tools/acp-agents/delivery#post-deploy-smoke-test)
- <a id="sandbox-compatibility" />[Sandbox compatibility](/tools/acp-agents/delivery#sandbox-compatibility)
- <a id="session-target-resolution" />[Session target resolution](/tools/acp-agents/controls#session-target-resolution)
- <a id="session-owner-and-harness" />[Session owner and harness](/tools/acp-agents/controls#session-owner-and-harness)
- <a id="acp-controls" />[ACP controls](/tools/acp-agents/controls#acp-controls)
- <a id="runtime-options-mapping" />[Runtime options mapping](/tools/acp-agents/controls#runtime-options-mapping)
- <a id="troubleshooting" />[Troubleshooting](/tools/acp-agents/troubleshooting#troubleshooting)

## Related

- [ACP agents - setup](/tools/acp-agents-setup)
- [Agent bindings](/concepts/agent-bindings)
- [Agent send](/tools/agent-send)
- [CLI Backends](/gateway/cli-backends)
- [Codex harness](/plugins/codex-harness)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
- [`openclaw acp` (bridge mode)](/cli/acp)
- [Sub-agents](/tools/subagents)
