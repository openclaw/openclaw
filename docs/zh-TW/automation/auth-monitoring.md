---
summary: Monitor OAuth expiry for model providers
read_when:
  - Setting up auth expiry monitoring or alerts
  - Automating Claude Code / Codex OAuth refresh checks
title: Auth Monitoring
---

# 認證監控

OpenClaw 透過 `openclaw models status` 提供 OAuth 到期健康狀態。可以利用這個功能進行自動化和警報；腳本則是電話工作流程的可選附加專案。

## 首選：CLI 檢查（可攜式）

```bash
openclaw models status --check
```

退出程式碼：

- `0`: 好的
- `1`: 憑證過期或遺失
- `2`: 即將過期（24小時內）

這在 cron/systemd 中運作良好，且不需要額外的腳本。

## 可選腳本（操作 / 電話工作流程）

這些位於 `scripts/` 並且是 **可選的**。它們假設對閘道主機有 SSH 存取權，並且針對 systemd + Termux 進行了調整。

- `scripts/claude-auth-status.sh` 現在使用 `openclaw models status --json` 作為真實來源（如果 CLI 無法使用，則回退到直接讀取檔案），因此請將 `openclaw` 保留在 `PATH` 以供計時器使用。
- `scripts/auth-monitor.sh`：cron/systemd 計時器目標；發送警報（ntfy 或電話）。
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`：systemd 使用者計時器。
- `scripts/claude-auth-status.sh`：Claude Code + OpenClaw 認證檢查器（完整/json/簡單）。
- `scripts/mobile-reauth.sh`：透過 SSH 的引導重新認證流程。
- `scripts/termux-quick-auth.sh`：一鍵小工具狀態 + 開啟認證 URL。
- `scripts/termux-auth-widget.sh`：完整的引導小工具流程。
- `scripts/termux-sync-widget.sh`：同步 Claude Code 憑證 → OpenClaw。

如果您不需要電話自動化或 systemd 計時器，可以跳過這些腳本。
