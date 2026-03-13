---
summary: CLI reference for `openclaw sessions` (list stored sessions + usage)
read_when:
  - You want to list stored sessions and see recent activity
title: sessions
---

# `openclaw sessions`

列出已儲存的對話會話。

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --json
```

範圍選擇：

- default：預設設定的代理儲存
- `--agent <id>`：單一設定的代理儲存
- `--all-agents`：彙整所有設定的代理儲存
- `--store <path>`：明確指定儲存路徑（不可與 `--agent` 或 `--all-agents` 一起使用）

`openclaw sessions --all-agents` 讀取設定的代理儲存。Gateway 和 ACP
會話發現範圍更廣：它們也包含位於預設 `agents/` 根目錄或模板化 `session.store` 根目錄下的僅磁碟儲存。這些
被發現的儲存必須解析為代理根目錄內的常規 `sessions.json` 檔案；符號連結和根目錄外的路徑會被跳過。

JSON 範例：

`openclaw sessions --all-agents --json`：

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/sessions/sessions.json" }
  ],
  "allAgents": true,
  "count": 2,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-5" }
  ]
}
```

## 清理維護

立即執行維護（不必等待下一個寫入週期）：

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:dm:123"
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` 使用設定檔中的 `session.maintenance` 設定：

- 範圍說明：`openclaw sessions cleanup` 僅維護會話儲存/記錄。它不會修剪排程執行日誌 (`cron/runs/<jobId>.jsonl`)，這些由 [排程設定](/automation/cron-jobs#configuration) 中的 `cron.runLog.maxBytes` 和 `cron.runLog.keepLines` 管理，並在 [排程維護](/automation/cron-jobs#maintenance) 中說明。

- `--dry-run`：預覽將被修剪/限制的條目數量，但不會寫入。
  - 在文字模式下，模擬執行會列印每個會話的動作表 (`Action`、`Key`、`Age`、`Model`、`Flags`)，讓你能看到哪些會被保留或移除。
- `--enforce`：即使 `session.maintenance.mode` 是 `warn`，也強制執行維護。
- `--active-key <key>`：保護特定的活躍金鑰不被磁碟配額驅逐。
- `--agent <id>`：針對單一設定的代理儲存執行清理。
- `--all-agents`：針對所有設定的代理儲存執行清理。
- `--store <path>`：針對特定 `sessions.json` 檔案執行。
- `--json`：列印 JSON 摘要。搭配 `--all-agents`，輸出包含每個儲存的摘要。

`openclaw sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.openclaw/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

相關資訊：

- 會話設定：[設定參考](/gateway/configuration-reference#session)
