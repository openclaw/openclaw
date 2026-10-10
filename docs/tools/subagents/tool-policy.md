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

When settled children resume a requester after `sessions_yield`, the continuation
keeps the requester policy captured at spawn. The handoff must still belong to
the current requester session and settled batch, and every child in that batch
must carry the same verified requester policy. Conflicting or missing child
policies leave the continuation under its ordinary restricted policy. Current
tool restrictions and live revocation checks still apply at execution; the
handoff does not grant additional tools or infer a sender identity.

An automatic completion turn for a requester on the Claude CLI backend keeps that same
captured policy. The tools reach the CLI only through OpenClaw's policy-filtered
MCP surface, so native CLI tools stay disabled for the turn and every inherited
deny still applies. Other CLI backends, node-hosted Claude CLI sessions, and
settle batches do not regain requester tools. Message-tool-only replies keep
their existing source-bound `message` grant.

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

### Delegate tools to a coding agent

A front-door agent can remain unable to execute commands or edit files while
handing implementation to a separately configured coding agent. Allow the target
on the requesting agent:

```json5
{
  agents: {
    entries: {
      intake: {
        tools: { deny: ["exec", "process", "write", "edit", "apply_patch"] },
        subagents: {
          allowAgents: ["coder"],
        },
      },
      coder: {},
    },
  },
}
```

Cross-agent spawns allowed by `subagents.allowAgents` use the target agent's own
configured tools. The requester's agent-level allow/deny policy is not copied
onto the child, including visible sessions and configured ACP agent targets.
The target still applies global policy, its own policy, sandbox restrictions,
and the sub-agent restriction layer. Existing cross-agent children also ignore
an older requester-agent tool snapshot when their stored lineage identifies
the requester. External ACP harnesses that run under the requester agent keep
that agent's tool ceiling.

`openclaw doctor --fix` removes the retired `subagents.delegateToolsTo` setting
while preserving `allowAgents` and each agent's tool policy. Updates apply the
same repair through Doctor's normal config backup and write flow.

Same-agent hidden helpers keep the parent's effective tool ceiling. Restrictions
from `toolsBySender` or group/channel tool policy follow every descendant and
remain enforced on later turns, including owner resumes. Those requesters may
spawn only hidden helpers of the same agent; visible and cross-agent requests
remain forbidden.

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
