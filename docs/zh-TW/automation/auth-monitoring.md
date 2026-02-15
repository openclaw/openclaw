---
summary: "監控模型供應商的 OAuth 過期狀況"
read_when:
  - 設定憑證過期監控或警示時
  - 自動化 Claude Code / Codex OAuth 重新整理檢查時
title: "憑證監控"
---

# 憑證監控

OpenClaw 透過 `openclaw models status` 公開 OAuth 過期狀態。請將其用於自動化與警示；腳本則是針對手機工作流程的選配擴充。

## 偏好做法：CLI 檢查（可移植）

```bash
openclaw models status --check
```

結束代碼：

- `0`：正常
- `1`：憑證已過期或缺失
- `2`：即將過期（24 小時內）

這適用於 cron/systemd，且不需要額外的腳本。

## 選配腳本（維運 / 手機工作流程）

這些檔案位於 `scripts/` 下，且為**選配**。它們假設可以透過 SSH 存取 Gateway 主機，並針對 systemd + Termux 進行了調整。

- `scripts/claude-auth-status.sh` 現在使用 `openclaw models status --json` 作為單一事實來源（若 CLI 無法使用，則回退到直接讀取檔案），因此請確保 `openclaw` 已加入 `PATH` 以供計時器使用。
- `scripts/auth-monitor.sh`：cron/systemd 計時器目標；發送警示（ntfy 或手機）。
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`：systemd 使用者計時器。
- `scripts/claude-auth-status.sh`：Claude Code + OpenClaw 憑證檢查器（完整/JSON/簡單）。
- `scripts/mobile-reauth.sh`：透過 SSH 的引導式重新驗證流程。
- `scripts/termux-quick-auth.sh`：一鍵小工具狀態 + 開啟驗證 URL。
- `scripts/termux-auth-widget.sh`：完整引導式小工具流程。
- `scripts/termux-sync-widget.sh`：同步 Claude Code 憑證 → OpenClaw。

如果您不需要手機自動化或 systemd 計時器，可以略過這些腳本。
