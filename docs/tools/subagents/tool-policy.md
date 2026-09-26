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
`message`, and the `conversations_*` tools regardless of
depth or role (system-level/interactive tools, parent-owned progress cards, direct delivery surfaces, or
tools the main agent should coordinate). `sessions_send` is also denied by
default and can only be restored by the operator switch below, never by
`allow`/`alsoAllow`. This hard-deny layer is derived from
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

### Peer session messaging for spawned sub-agents

Spawned children coordinate by default through the announce chain: the parent
sends input, and a child reports completion back to its parent. Children cannot
message each other directly.

An operator can grant spawned sub-agents a bounded peer-messaging surface:

```json5
{
  tools: {
    subagents: {
      messaging: "peers",
    },
  },
}
```

With `messaging: "peers"`, native `sessions_spawn` subagent children (hidden
`agent:*:subagent:*` sessions) receive `sessions_send` again, but the grant is
clamped to the child's own agent (`tools.sessions.visibility=agent`): it can
address the parent, siblings, descendants, and other sessions belonging to the
same agent, but not cross-agent sessions. Visible dashboard children and ACP
children keep the hard deny. `message` and the `conversations_*` tools also stay
hard-denied, so channel delivery remains parent-owned. The grant is re-evaluated
from config on every turn: setting `messaging: "off"` (the default) removes the
tool again on the next turn.

This is an explicit operator decision because it widens the child's direct
session surface. Keep it `"off"` unless a multi-lane protocol such as
executor/verifier needs children to relay results to each other.

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
