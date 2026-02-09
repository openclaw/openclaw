---
summary: "「openclaw doctor」的 CLI 參考（健康檢查 + 引導式修復）"
read_when:
  - 你遇到連線或身分驗證問題，並希望取得引導式修復
  - 你已更新並想進行健全性檢查
title: "doctor"
---

# `openclaw doctor`

為 Gateway 閘道器與頻道提供健康檢查 + 快速修復。

Related:

- 疑難排解：[Troubleshooting](/gateway/troubleshooting)
- 安全性稽核：[Security](/gateway/security)

## 範例

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

注意事項：

- 互動式提示（例如鑰匙圈 / OAuth 修復）僅在 stdin 為 TTY 且 **未** 設定 `--non-interactive` 時才會執行。無頭執行（cron、Telegram、沒有終端機）將會略過提示。 Headless runs (cron, Telegram, no terminal) will skip prompts.
- `--fix`（`--repair` 的別名）會將備份寫入 `~/.openclaw/openclaw.json.bak`，並移除未知的 config 金鑰，同時列出每一項移除內容。

## macOS：`launchctl` 環境變數覆寫

如果你先前執行過 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`（或 `...PASSWORD`），該值會覆寫你的設定檔，並可能導致持續性的「未經授權」錯誤。

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
