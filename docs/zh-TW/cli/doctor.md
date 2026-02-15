---
summary: "`openclaw doctor` 的 CLI 參考 (健康檢查 + 引導式修復)"
read_when:
  - 您遇到連線/驗證問題並需要引導式修復
  - 您已更新並想進行完整性檢查
title: "doctor"
---

# `openclaw doctor`

Gateway 和頻道的健康檢查 + 快速修復。

相關資訊：

- 疑難排解：[疑難排解](/gateway/troubleshooting)
- 安全性稽核：[安全性](/gateway/security)

## 範例

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

備註：

- 互動式提示（例如鑰匙圈/OAuth 修復）僅在標準輸入 (stdin) 為 TTY 且**未**設定 `--non-interactive` 時執行。無頭模式執行（cron、Telegram、無終端機）將會跳過提示。
- `--fix`（為 `--repair` 的別名）會將備份寫入 `~/.openclaw/openclaw.json.bak` 並刪除未知的設定鍵，同時列出每個被移除的項目。

## macOS: `launchctl` 環境變數覆寫

如果您之前執行過 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`（或 `...PASSWORD`），該值會覆寫您的設定檔案，並可能導致持續性的「未授權」錯誤。

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
