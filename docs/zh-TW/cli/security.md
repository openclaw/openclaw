---
summary: "CLI 參考文件，關於 `openclaw security`（稽核並修復常見的安全漏洞）"
read_when:
  - 您想對設定/狀態執行快速安全稽核
  - 您想套用安全「修復」建議 (chmod, 強化預設值)
title: "安全性"
---

# `openclaw security`

安全工具（稽核 + 選用修復）。

相關：

- 安全指南：[安全性](/gateway/security)

## 稽核

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

當多個私訊發送者共用主會話時，稽核會發出警告，並建議為共用收件匣使用 **安全私訊模式**：`session.dmScope="per-channel-peer"`（或針對多帳戶通道使用 `per-account-channel-peer`）。
它還會針對在未使用沙盒（sandboxing）且啟用網頁/瀏覽器工具的情況下使用小型模型（`<=300B`）時發出警告。
對於 webhook 傳入，當 `hooks.defaultSessionKey` 未設定、請求的 `sessionKey` 覆寫已啟用，以及在未設定 `hooks.allowedSessionKeyPrefixes` 的情況下啟用覆寫時，它會發出警告。
當沙盒 Docker 設定已配置但沙盒模式已關閉時、當 `gateway.nodes.denyCommands` 使用無效的模式式/未知條目時、當全域 `tools.profile="minimal"` 被代理（agent）工具設定檔覆寫時，以及當已安裝的擴充外掛程式工具在寬鬆的工具策略下可能可存取時，它也會發出警告。
