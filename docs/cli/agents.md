---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw agents` (list/add/delete/set identity)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want multiple isolated agents (workspaces + routing + auth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "agents"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw agents`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage isolated agents (workspaces + auth + routing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent workspace: [Agent workspace](/concepts/agent-workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents add work --workspace ~/.openclaw/workspace-work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents set-identity --agent main --avatar avatars/openclaw.png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents delete work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Identity files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each agent workspace can include an `IDENTITY.md` at the workspace root:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example path: `~/.openclaw/workspace/IDENTITY.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Avatar paths resolve relative to the workspace root.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Set identity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`set-identity` writes fields into `agents.list[].identity`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `name`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `theme`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emoji`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `avatar` (workspace-relative path, http(s) URL, or data URI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Load from `IDENTITY.md`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Override fields explicitly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config sample:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        identity: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          name: "OpenClaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          theme: "space lobster",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          emoji: "🦞",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          avatar: "avatars/openclaw.png",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
