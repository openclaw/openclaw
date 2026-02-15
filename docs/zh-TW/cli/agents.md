---
summary: "`openclaw agents` 的 CLI 參考文件 (列出/新增/刪除/設定識別資訊)"
read_when:
  - 您需要多個隔離的智慧代理 (工作區 + 路由 + 驗證)
title: "agents"
---

# `openclaw agents`

管理隔離的智慧代理 (工作區 + 驗證 + 路由)。

相關資訊：

- 多智慧代理路由：[Multi-Agent Routing](/concepts/multi-agent)
- 智慧代理工作區：[Agent workspace](/concepts/agent-workspace)

## 範例

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## 識別資訊檔案

每個智慧代理工作區都可以在工作區根目錄包含一個 `IDENTITY.md` 檔案：

- 範例路徑：`~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` 會從工作區根目錄 (或指定的 `--identity-file`) 讀取內容。

大頭貼路徑會相對於工作區根目錄進行解析。

## 設定識別資訊

`set-identity` 會將欄位寫入 `agents.list[].identity`：

- `name`
- `theme`
- `emoji`
- `avatar` (工作區相對路徑、http(s) URL 或 data URI)

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
