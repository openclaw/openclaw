---
summary: CLI reference for `openclaw sessions` (list stored sessions + usage)
read_when:
  - You want to list stored sessions and see recent activity
title: sessions
---

# `openclaw sessions`

列出儲存的對話會話。

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --json
```

範圍選擇：

- default: 已設定的預設代理商儲存
- `--agent <id>`: 一個已設定的代理商儲存
- `--all-agents`: 聚合所有已設定的代理商儲存
- `--store <path>`: 明確的儲存路徑（不能與 `--agent` 或 `--all-agents` 組合使用）

`openclaw sessions --all-agents` 讀取已設定的代理儲存。網關和 ACP 會話發現的範圍更廣：它們還包括在預設 `agents/` 根目錄或模板 `session.store` 根目錄下找到的僅磁碟儲存。那些被發現的儲存必須解析為代理根目錄內的常規 `sessions.json` 檔案；符號連結和超出根目錄的路徑將被跳過。

JSON 範例:

`openclaw sessions --all-agents --json`:

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

## Cleanup maintenance

立即執行維護（而不是等待下一次寫入週期）：

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:dm:123"
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` 使用來自設定的 `session.maintenance` 設定：

- 範圍說明：`openclaw sessions cleanup` 僅維護會話存儲/記錄。它不會修剪 cron 執行日誌 (`cron/runs/<jobId>.jsonl`)，這些日誌由 `cron.runLog.maxBytes` 和 `cron.runLog.keepLines` 在 [Cron 設定](/automation/cron-jobs#configuration) 中管理，並在 [Cron 維護](/automation/cron-jobs#maintenance) 中進行說明。

- `--dry-run`: 預覽在不寫入的情況下會修剪/限制多少條目。
  - 在文字模式下，dry-run 會列印每個會話的操作表 (`Action`, `Key`, `Age`, `Model`, `Flags`)，讓你可以看到哪些會被保留，哪些會被移除。
- `--enforce`: 即使 `session.maintenance.mode` 是 `warn`，也應用維護。
- `--active-key <key>`: 保護特定的活動金鑰，避免被磁碟預算驅逐。
- `--agent <id>`: 對一個設定的代理儲存執行清理。
- `--all-agents`: 對所有設定的代理儲存執行清理。
- `--store <path>`: 對特定的 `sessions.json` 檔案執行。
- `--json`: 列印 JSON 摘要。使用 `--all-agents` 時，輸出包括每個儲存的摘要。

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

[[BLOCK_1]]

- 會話設定: [設定參考](/gateway/configuration-reference#session)
