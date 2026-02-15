---
summary: "CLI 參考 `openclaw agent` (透過 Gateway 傳送一個智慧代理回合)"
read_when:
  - 您想從腳本執行一個智慧代理回合 (可選地遞送回覆)
title: "agent"
---

# `openclaw agent`

透過 Gateway 執行一個智慧代理回合 (使用 `--local` 進行嵌入式操作)。
使用 `--agent <id>` 直接指定一個已設定的智慧代理。

相關內容：

- 智慧代理傳送工具：[智慧代理傳送](/tools/agent-send)

## 範例

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
