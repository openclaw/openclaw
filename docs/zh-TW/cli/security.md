---
summary: "「openclaw security」的 CLI 參考文件（稽核並修復常見的安全性陷阱）"
read_when:
  - 你想要對設定／狀態執行快速的安全性稽核
  - 你想要套用安全的「修復」建議（chmod、收緊預設值）
title: "安全性"
---

# `openclaw security`

安全性工具（稽核 + 可選的修復）。

20. 相關：

- 安全性指南：[Security](/gateway/security)

## 稽核

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

當多個 DM 寄件者共用主要工作階段時，稽核會提出警告，並建議在共用收件匣中使用 **安全 DM 模式**：`session.dmScope="per-channel-peer"`（或針對多帳號頻道使用 `per-account-channel-peer`）。
此外，當未啟用沙箱隔離且同時啟用網頁／瀏覽器工具時，若使用小型模型（`<=300B`），也會發出警告。
21. 當未啟用沙箱且啟用網路／瀏覽器工具時，也會在使用小型模型（`<=300B`）時發出警告。
