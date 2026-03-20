---
summary: "OpenClaw tools and plugins overview: what the agent can do and how to extend it"
read_when:
  - You want to understand what tools OpenClaw provides
  - You need to configure, allow, or deny tools
  - You are deciding between built-in tools, skills, and plugins
title: "Tools and Plugins"
---

# Tools and Plugins

OpenClaw gives the agent a set of **tools** it can call during a conversation.
Tools are how the agent reads files, runs commands, browses the web, sends
messages, and interacts with devices. Everything the agent does beyond generating
text happens through tools.

## How it all fits together

<CardGroup cols={2}>
  <Card title="Built-in tools" icon="wrench" href="/tools/exec">
    Core tools shipped with OpenClaw: exec, browser, web search, file I/O,
    messaging, cron, canvas, and nodes.
  </Card>
  <Card title="Skills" icon="book-open" href="/tools/skills">
    Markdown instructions that teach the agent how and when to use tools.
    Skills ship inside plugins or live in your workspace.
  </Card>
  <Card title="Plugins" icon="puzzle-piece" href="/tools/plugin">
    Packages that add new capabilities: channels, model providers, tools,
    skills, or any combination. Published on npm and installed with the CLI.
  </Card>
  <Card title="Automation" icon="clock" href="/automation/hooks">
    Hooks, cron jobs, heartbeats, webhooks, and scheduled tasks that run
    without manual messages.
  </Card>
</CardGroup>

## Tool configuration

### Allow and deny lists

Control which tools the agent can call via `tools.allow` / `tools.deny` in
config. Deny always wins over allow.

```json5
{
  tools: {
    allow: ["group:fs", "browser", "web_search"],
    deny: ["exec"],
  },
}
```

### Tool profiles

`tools.profile` sets a base allowlist before `allow`/`deny` is applied.
Per-agent override: `agents.list[].tools.profile`.

| Profile     | What it includes                            |
| ----------- | ------------------------------------------- |
| `full`      | All tools (default)                         |
| `coding`    | File I/O, runtime, sessions, memory, image  |
| `messaging` | Messaging, session list/history/send/status |
| `minimal`   | `session_status` only                       |

### Tool groups

Use `group:*` shorthands in allow/deny lists:

| Group              | Tools                                                                          |
| ------------------ | ------------------------------------------------------------------------------ |
| `group:runtime`    | exec, bash, process                                                            |
| `group:fs`         | read, write, edit, apply_patch                                                 |
| `group:sessions`   | sessions_list, sessions_history, sessions_send, sessions_spawn, session_status |
| `group:memory`     | memory_search, memory_get                                                      |
| `group:web`        | web_search, web_fetch                                                          |
| `group:ui`         | browser, canvas                                                                |
| `group:automation` | cron, gateway                                                                  |
| `group:messaging`  | message                                                                        |
| `group:nodes`      | nodes                                                                          |
| `group:openclaw`   | All built-in OpenClaw tools (excludes plugin tools)                            |

### Provider-specific restrictions

Use `tools.byProvider` to restrict tools for specific providers without
changing global defaults:

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

## Built-in tool reference

For the full tool-by-tool reference (parameters, actions, notes), see the
individual tool pages in the sidebar. Key tools:

| Tool                         | What it does                                             | Page                              |
| ---------------------------- | -------------------------------------------------------- | --------------------------------- |
| `exec` / `process`           | Run shell commands, manage background processes          | [Exec](/tools/exec)               |
| `browser`                    | Control a Chromium browser (navigate, click, screenshot) | [Browser](/tools/browser)         |
| `web_search` / `web_fetch`   | Search the web, fetch page content                       | [Web](/tools/web)                 |
| `read` / `write` / `edit`    | File I/O in the workspace                                |                                   |
| `apply_patch`                | Multi-hunk file patches                                  | [Apply Patch](/tools/apply-patch) |
| `message`                    | Send messages across all channels                        | [Agent Send](/tools/agent-send)   |
| `canvas`                     | Drive node Canvas (present, eval, snapshot)              |                                   |
| `nodes`                      | Discover and target paired devices                       |                                   |
| `cron` / `gateway`           | Manage scheduled jobs, restart gateway                   |                                   |
| `image` / `image_generate`   | Analyze or generate images                               |                                   |
| `sessions_*` / `agents_list` | Session management, sub-agents                           | [Sub-agents](/tools/subagents)    |

## Plugins add more

Plugins can register **additional tools** beyond the built-in set. Some examples:

- [Lobster](/tools/lobster) — typed workflow runtime with resumable approvals
- [LLM Task](/tools/llm-task) — JSON-only LLM step for structured output
- [Diffs](/tools/diffs) — diff viewer and renderer
- [OpenProse](/prose) — markdown-first workflow orchestration

Plugins can also ship **skills** alongside tools, so the agent gets both the
tool definition and the instructions for using it. See
[Building Plugins](/plugins/building-plugins) to create your own.

## How tools reach the agent

Tools are exposed in two parallel channels:

1. **System prompt text** — a human-readable list with guidance (from skills)
2. **Tool schemas** — structured function definitions sent to the model API

If a tool doesn't appear in either, the model cannot call it.
