---
summary: "CLI reference for `smart-agent-neo agents` (list/add/delete/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
---

# `smart-agent-neo agents`

Manage isolated agents (workspaces + auth + routing).

Related:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
smart-agent-neo agents list
smart-agent-neo agents add work --workspace ~/.smart-agent-neo/workspace-work
smart-agent-neo agents set-identity --workspace ~/.smart-agent-neo/workspace --from-identity
smart-agent-neo agents set-identity --agent main --avatar avatars/smart-agent-neo.png
smart-agent-neo agents delete work
```

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.smart-agent-neo/workspace/IDENTITY.md`
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`)

Avatar paths resolve relative to the workspace root.

## Set identity

`set-identity` writes fields into `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative path, http(s) URL, or data URI)

Load from `IDENTITY.md`:

```bash
smart-agent-neo agents set-identity --workspace ~/.smart-agent-neo/workspace --from-identity
```

Override fields explicitly:

```bash
smart-agent-neo agents set-identity --agent main --name "SmartAgentNeo" --emoji "🦞" --avatar avatars/smart-agent-neo.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "SmartAgentNeo",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/smart-agent-neo.png",
        },
      },
    ],
  },
}
```
