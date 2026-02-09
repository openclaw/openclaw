---
summary: "用於 `openclaw agent` 的 CLI 參考（透過 Gateway 閘道器 傳送一次代理程式回合）"
read_when:
  - 你想要從指令碼執行一次代理程式回合（可選擇是否傳遞回覆）
title: "agent"
---

# `openclaw agent`

透過 Gateway 閘道器 執行一次代理程式回合（內嵌使用請改用 `--local`）。
使用 `--agent <id>` 以直接指定已設定的代理程式。
Use `--agent <id>` to target a configured agent directly.

Related:

- 代理程式傳送工具：[Agent send](/tools/agent-send)

## 範例

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
