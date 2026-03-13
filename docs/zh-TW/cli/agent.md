---
summary: CLI reference for `openclaw agent` (send one agent turn via the Gateway)
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
title: agent
---

# `openclaw agent`

透過 Gateway 執行代理轉換（使用 `--local` 進行嵌入）。使用 `--agent <id>` 直接針對已設定的代理。

相關：

- 代理發送工具: [Agent send](/tools/agent-send)

## 範例

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## 註解

- 當此命令觸發 `models.json` 再生時，SecretRef 管理的提供者憑證會以非秘密標記的形式持久化（例如環境變數名稱、`secretref-env:ENV_VAR_NAME` 或 `secretref-managed`），而不是解析的秘密明文。
- 標記寫入是來源權威的：OpenClaw 從活動來源設定快照中持久化標記，而不是從解析的執行時秘密值中。
