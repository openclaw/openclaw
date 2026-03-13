---
summary: CLI reference for `openclaw doctor` (health checks + guided repairs)
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: doctor
---

# `openclaw doctor`

健康檢查 + 快速修復網關和通道。

[[BLOCK_1]]

- 故障排除: [Troubleshooting](/gateway/troubleshooting)
- 安全審核: [Security](/gateway/security)

## Examples

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

[[BLOCK_1]]

- 互動提示（如金鑰鏈/OAuth 修正）僅在 stdin 為 TTY 且 `--non-interactive` **未** 設定時執行。無頭執行（cron、Telegram、無終端機）將跳過提示。
- `--fix`（`--repair` 的別名）會將備份寫入 `~/.openclaw/openclaw.json.bak`，並刪除未知的設定鍵，列出每個移除專案。
- 狀態完整性檢查現在可以檢測到會話目錄中的孤立轉錄檔案，並可以將它們歸檔為 `.deleted.<timestamp>` 以安全地回收空間。
- Doctor 也會掃描 `~/.openclaw/cron/jobs.json`（或 `cron.store`）以尋找舊版 cron 工作形狀，並可以在排程器必須在執行時自動標準化之前就地重寫它們。
- Doctor 包含記憶體搜尋準備檢查，並可以在嵌入憑證缺失時建議 `openclaw configure --section model`。
- 如果啟用了沙盒模式但 Docker 不可用，doctor 會報告高信號警告並提供修正建議 (`install Docker` 或 `openclaw config set agents.defaults.sandbox.mode off`)。

## macOS: `launchctl` 環境變數覆蓋

如果您之前執行了 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (或 `...PASSWORD`)，該值會覆蓋您的設定檔，並可能導致持續的「未授權」錯誤。

bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN  
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
