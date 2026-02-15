---
summary: "`openclaw doctor` 的 CLI 參考文件（健康檢查 + 引導修復）"
read_when:
  - 當您遇到連線/驗證問題並希望獲得引導式修復時
  - 當您更新後想要進行完整性檢查時
title: "doctor"
---

# `openclaw doctor`

Gateway 與頻道的健康檢查 + 快速修復。

相關資訊：

- 疑難排解：[疑難排解](/gateway/troubleshooting)
- 安全性稽核：[安全性](/gateway/security)

## 範例

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

注意事項：

- 互動式提示（如 keychain/OAuth 修復）僅在 stdin 為 TTY 且**未**設定 `--non-interactive` 時執行。無介面執行（如 cron、Telegram、無終端機環境）將跳過提示。
- `--fix`（`--repair` 的別名）會將備份寫入 `~/.openclaw/openclaw.json.bak` 並捨棄未知的設定鍵值，並列出每個移除的項目。

## macOS：`launchctl` 環境變數覆蓋

如果您先前執行過 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`（或 `...PASSWORD`），該值會覆蓋您的設定檔案，並可能導致持續出現「unauthorized」錯誤。

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
