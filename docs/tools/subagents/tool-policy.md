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

New native children also retain the originating task's configured action
restrictions. Receiver restrictions apply alongside them, including supported
exec, filesystem, and sandbox constraints. The capture describes restrictions,
not just the tools available at launch: enabling an optional tool later cannot
erase a deny rule, and a temporarily unavailable permitted tool is not
permanently excluded. Nested children retain the conjunction.

Acceptance transfers these restrictions to the child. They survive normal
sender completion, child resume, and Gateway restart. Receiver credentials,
approvals, and live execution authority remain with their existing owners;
creating a child does not transfer them. If a backend cannot enforce a required
constraint, the spawn fails explicitly. ACP accepts and retains saved policies
when its host execution can satisfy them. Constraints ACP cannot enforce cause
an explicit refusal; use the native subagent backend for that work. Standalone
CLI execution does not accept these saved native action restrictions.

An isolated transcript is separate conversation context, not proof of resource
isolation. File-tool workspace restrictions do not confine shell commands, and
a sandbox does not automatically confine custom plugin operations. See
[Sandboxing](/gateway/sandboxing).

Completion still returns through the requester's authorized reply path. These
action restrictions do not make the answer confidential or restrict unrelated
work in the requesting conversation.

Existing version-1 tasks keep their recorded legacy tool-policy interpretation.
The new saved format requires agent database schema 24. After migration, older
binaries refuse the database, including databases without delegated tasks.
Binary-only rollback is therefore unavailable; use the existing verified
pre-upgrade backup recovery procedure with compatible binaries. Restoring that
backup can lose work created afterward. See
[Database versioning](/reference/database-schemas/versioning).

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
