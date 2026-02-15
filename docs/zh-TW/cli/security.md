---
summary: "openclaw security 的 CLI 參考文件（稽核並修復常見的安全疏失）"
read_when:
  - 您想對設定/狀態執行快速安全稽核時
  - 您想套用安全的「修復」建議（如 chmod、收緊預設值）時
title: "security"
---

# `openclaw security`

安全性工具（稽核 + 選用修復）。

相關內容：

- 安全性指南：[Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

稽核會在多個私訊傳送者共用主工作階段時發出警告，並建議在共用收件匣中使用**安全私訊模式**：`session.dmScope="per-channel-peer"`（或針對多帳號頻道使用 `per-account-channel-peer`）。
當在未開啟沙箱隔離且啟用了網頁/瀏覽器工具的情況下使用小型模型（`<=300B`）時，它也會發出警告。
針對 Webhook 入口，當未設定 `hooks.defaultSessionKey`、啟用了請求 `sessionKey` 覆寫，或在未設定 `hooks.allowedSessionKeyPrefixes` 的情況下啟用了覆寫時，它會發出警告。
它還會在以下情況發出警告：在沙箱模式關閉時設定了沙箱 Docker 設定、`gateway.nodes.denyCommands` 使用了無效的模式化/未知項目、全域的 `tools.profile="minimal"` 被智慧代理工具設定檔覆寫，以及安裝的擴充外掛工具在寬鬆的工具原則下可能被存取時。
