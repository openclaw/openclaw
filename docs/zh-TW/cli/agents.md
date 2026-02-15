```
---
summary: "CLI `openclaw agents` (列出/新增/刪除/設定身分) 的參考文件"
read_when:
  - 您需要多個獨立的智慧代理 (工作區 + 路由 + 憑證)
title: "智慧代理"
---

# `openclaw agents`

管理獨立的智慧代理 (工作區 + 憑證 + 路由)。

相關項目：

- 多智慧代理路由: [Multi-Agent Routing](/concepts/multi-agent)
- 智慧代理工作區: [Agent workspace](/concepts/agent-workspace)

## 範例

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## 身分檔案

每個智慧代理工作區都可以在工作區根目錄中包含一個 `IDENTITY.md` 檔案：

- 範例路徑: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` 從工作區根目錄 (或明確的 `--identity-file`) 讀取

頭像路徑會相對於工作區根目錄解析。

## 設定身分

`set-identity` 將欄位寫入 `agents.list[].identity`：

- `name`
- `theme`
- `emoji`
- `avatar` (工作區相對路徑、http(s) URL 或資料 URI)

從 `IDENTITY.md` 載入：

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

明確覆寫欄位：

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

設定檔範例：

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
