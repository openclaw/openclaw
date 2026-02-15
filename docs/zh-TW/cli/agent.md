---
summary: "`openclaw agent` 的 CLI 參考文件 (透過 Gateway 傳送一個智慧代理輪次)"
read_when:
  - "您想要從指令碼執行一個智慧代理輪次 (並可選擇性傳送回覆)"
title: "agent"
---

# `openclaw agent`

透過 Gateway 執行一個智慧代理輪次 (使用 `--local` 執行嵌入式版本)。
使用 `--agent <id>` 直接指定已設定的智慧代理。

相關內容：

- 智慧代理傳送工具：[Agent send](/tools/agent-send)

## 範例

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
