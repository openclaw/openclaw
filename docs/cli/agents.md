---
summary: "CLI reference for `activi agents` (list/add/delete/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
---

# `activi agents`

Manage isolated agents (workspaces + auth + routing).

Related:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
activi agents list
activi agents add work --workspace ~/.activi/workspace-work
activi agents set-identity --workspace ~/.activi/workspace --from-identity
activi agents set-identity --agent main --avatar avatars/activi.png
activi agents delete work
```

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.activi/workspace/IDENTITY.md`
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
activi agents set-identity --workspace ~/.activi/workspace --from-identity
```

Override fields explicitly:

```bash
activi agents set-identity --agent main --name "Activi" --emoji "🦞" --avatar avatars/activi.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Activi",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/activi.png",
        },
      },
    ],
  },
}
```
