---
summary: "CLI reference for `EasyHub agents` (list/add/delete/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
---

# `EasyHub agents`

Manage isolated agents (workspaces + auth + routing).

Related:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
EasyHub agents list
EasyHub agents add work --workspace ~/.easyhub/workspace-work
EasyHub agents set-identity --workspace ~/.easyhub/workspace --from-identity
EasyHub agents set-identity --agent main --avatar avatars/EasyHub.png
EasyHub agents delete work
```

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.easyhub/workspace/IDENTITY.md`
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
EasyHub agents set-identity --workspace ~/.easyhub/workspace --from-identity
```

Override fields explicitly:

```bash
EasyHub agents set-identity --agent main --name "EasyHub" --emoji "🦞" --avatar avatars/EasyHub.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "EasyHub",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/EasyHub.png",
        },
      },
    ],
  },
}
```
