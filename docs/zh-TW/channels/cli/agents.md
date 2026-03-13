---
summary: >-
  CLI reference for `openclaw agents` (list/add/delete/bindings/bind/unbind/set
  identity)
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: agents
---

# `openclaw agents`

管理獨立代理（工作區 + 認證 + 路由）。

[[BLOCK_1]]

- 多代理路由: [Multi-Agent Routing](/concepts/multi-agent)
- 代理工作區: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents bindings
openclaw agents bind --agent work --bind telegram:ops
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## Routing bindings

使用路由綁定將進入的通道流量固定到特定的代理。

[[BLOCK_1]]  
List bindings:  
[[BLOCK_1]]

```bash
openclaw agents bindings
openclaw agents bindings --agent work
openclaw agents bindings --json
```

添加綁定：

```bash
openclaw agents bind --agent work --bind telegram:ops --bind discord:guild-a
```

如果您省略 `accountId` (`--bind <channel>`)，OpenClaw 將在可用時從通道預設值和插件設置鉤子中解析它。

### Binding scope 行為

- 沒有 `accountId` 的綁定僅匹配通道的預設帳戶。
- `accountId: "*"` 是通道範圍的後備選項（所有帳戶），並且比明確的帳戶綁定更不具體。
- 如果同一代理已經有一個匹配的通道綁定而沒有 `accountId`，而你後來使用明確或解析的 `accountId` 進行綁定，OpenClaw 將在原地升級該現有綁定，而不是添加重複的綁定。

[[BLOCK_1]]  
範例：  
[[INLINE_1]]

bash

# 初始的僅通道綁定

openclaw agents bind --agent work --bind telegram

# 後續升級至帳戶範圍的綁定

openclaw agents bind --agent work --bind telegram:ops

升級後，該綁定的路由範圍限定於 `telegram:ops`。如果您還想要預設帳戶路由，請明確添加它（例如 `--bind telegram:default`）。

[[BLOCK_1]]  
移除綁定：  
[[BLOCK_1]]

```bash
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents unbind --agent work --all
```

## 身分檔案

每個代理工作區可以在工作區根目錄包含一個 `IDENTITY.md`：

- 範例路徑: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` 從工作區根目錄（或明確的 `--identity-file`）讀取。

Avatar 路徑是相對於工作區根目錄解析的。

## Set identity

`set-identity` 將欄位寫入 `agents.list[].identity`：

- `name`
- `theme`
- `emoji`
- `avatar` (工作區相對路徑、http(s) URL 或數據 URI)

Load from `IDENTITY.md`:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

[[BLOCK_1]]  
明確覆寫欄位：  
[[BLOCK_1]]

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
