---
summary: "The sub-agent tool restriction layer and how to narrow it with config"
title: "Sub-agent tool policy"
read_when:
  - You need to know which tools a sub-agent always loses
  - You want to allow or deny specific tools for sub-agents
---

## Tool policy

Sub-agents use the same profile and tool-policy pipeline as the parent or
target agent first. After that, OpenClaw applies the sub-agent restriction
layer.

Sub-agents always lose `gateway`, `agents_list`, `session_status`, `progress_card`, `cron`,
`message`, `sessions_send`, and the `conversations_*` tools regardless of
depth or role (system-level/interactive tools, parent-owned progress cards, direct delivery surfaces, or
tools the main agent should coordinate). This hard-deny layer is derived from
the persisted sub-agent session envelope on every turn, including resumed and
visible dashboard sessions; ordinary `allow`/`alsoAllow` entries cannot override
it. Hidden launches also disable `message` before tool construction as defense in
depth. Sub-agents at the configured depth cap additionally
lose `subagents`, `sessions_list`, `sessions_history`, and `sessions_spawn`, so
their communication stays on the announce chain.

`sessions_history` remains a bounded, redacted recall view here too — it
is neither a raw transcript dump nor a prose-only rendering.

By default, sub-agents below depth `5` receive `sessions_spawn`, `subagents`,
`sessions_list`, and `sessions_history` so they can manage their children.

### Override via config

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

`tools.subagents.tools.allow` is a final allow-only filter. It can narrow
the already-resolved tool set, but it cannot **add back** a tool removed
by `tools.profile`. For example, `tools.profile: "coding"` includes
`web_search`/`web_fetch` but not the `browser` tool. To let
coding-profile sub-agents use browser automation, add browser at the
profile stage:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["browser"],
  },
}
```

Use per-agent `agents.entries.*.tools.alsoAllow: ["browser"]` when only one
agent should get browser automation.
