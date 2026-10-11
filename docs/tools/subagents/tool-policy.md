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
their existing source-bound `message` grant. When that restricted surface needs
its own Claude CLI session, the requester's next resumed turn receives the
completion prompt and reply as quoted context; see
[CLI backends](/gateway/cli-backends#sessions).

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
handing implementation to a separately configured coding agent. Opt in for each
target on the requesting agent:

```json5
{
  agents: {
    entries: {
      intake: {
        tools: { deny: ["exec", "process", "write", "edit", "apply_patch"] },
        subagents: {
          allowAgents: ["coder"],
          delegateToolsTo: ["coder"],
        },
      },
      coder: {},
    },
  },
}
```

`delegateToolsTo` is an operator-owned permission, not a `sessions_spawn`
argument. It names exact configured target agents; it does not replace
`allowAgents` or permit arbitrary targets. Without this grant, the existing
caller tool ceiling is unchanged. The intake agent remains locally restricted.

The grant applies to native cross-agent handoffs and relaxes only the requesting
agent's own `tools.deny` layer. Global, provider, sender, conversation, sandbox,
and inherited restrictions are not delegation grants. Duplicate denials at
those layers remain denied, and the target still applies its own current tool
policy and the hard sub-agent restrictions. A restrictive inherited allowlist
cannot be discarded to make a handoff work. An explicit grant that cannot be
projected safely fails before creation instead of starting an unusable child.
ACP retains its original inheritance and admission checks.

The initial handoff requires a Gateway-side native tool surface and local
placement. Cloud-worker and CLI-mediated spawn surfaces cannot originate or
propagate the exception. Supported CLI and plugin harness targets use
OpenClaw-mediated tools, not an ambient native command surface, so grant
revocation can be checked before effects. Backends that cannot enforce that
projection refuse the run.

Same-agent native helpers of the coding target retain the grant and any
additional restrictions. They cannot transfer it to a third agent. Completion
back to the intake agent preserves the intake agent’s original tool snapshot.
Removing the target grant or its `allowAgents` admission restores the original
ceiling on subsequent preparation and rejects retained actions that depended on
the grant before their effects. Already-started effects are not rolled back.

Existing sessions keep their recorded policy; adding this setting does not
retroactively upgrade a previously created child.

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
