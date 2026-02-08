---
summary: " `openclaw agents` 的 CLI 參考（list/add/delete/set identity）"
read_when:
  - 您需要多個相互隔離的代理程式（工作區 + 路由 + 身分驗證）
title: "agents"
x-i18n:
  source_path: cli/agents.md
  source_hash: 30556d81636a9ad8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:11Z
---

# `openclaw agents`

管理相互隔離的代理程式（工作區 + 身分驗證 + 路由）。

相關內容：

- 多代理程式路由：[Multi-Agent Routing](/concepts/multi-agent)
- 代理程式工作區：[Agent workspace](/concepts/agent-workspace)

## 範例

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## 身分檔案

每個代理程式工作區都可以在工作區根目錄包含一個 `IDENTITY.md`：

- 範例路徑：`~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` 會從工作區根目錄讀取（或使用明確指定的 `--identity-file`）

頭像路徑會相對於工作區根目錄解析。

## 設定身分

`set-identity` 會將欄位寫入 `agents.list[].identity`：

- `name`
- `theme`
- `emoji`
- `avatar`（工作區相對路徑、http(s) URL，或 data URI）

從 `IDENTITY.md` 載入：

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

明確覆寫欄位：

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

設定範例：

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
