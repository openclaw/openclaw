---
summary: "監控模型供應商的 OAuth 到期"
read_when:
  - 設定憑證到期監控或警報
  - 自動化 Claude Code / Codex OAuth 重新整理檢查
title: "憑證監控"
---

# 憑證監控

OpenClaw 透過 `openclaw models status` 公開 OAuth 到期健康狀態。將其用於自動化和警報；指令碼是手機工作流程的選用附加功能。

## 建議：CLI 檢查 (可攜式)

```bash
openclaw models status --check
```

結束碼：

- `0`：正常
- `1`：憑證已到期或遺失
- `2`：即將到期（24 小時內）

這適用於 cron/systemd 且無需額外指令碼。

## 選用指令碼 (營運 / 手機工作流程)

這些位於 `scripts/` 下，且為**選用**。它們假設可以透過 SSH 存取 Gateway 主機，並針對 systemd + Termux 進行了調整。

- `scripts/claude-auth-status.sh` 現在使用 `openclaw models status --json` 作為事實的來源（如果 CLI 不可用，則會退回到直接讀取檔案），因此請將 `openclaw` 保留在 `PATH` 中以用於計時器。
- `scripts/auth-monitor.sh`：cron/systemd 計時器目標；傳送警報 (ntfy 或手機)。
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`：systemd 使用者計時器。
- `scripts/claude-auth-status.sh`：Claude Code + OpenClaw 憑證檢查器 (完整/json/簡易)。
- `scripts/mobile-reauth.sh`：透過 SSH 的引導式重新憑證流程。
- `scripts/termux-quick-auth.sh`：一鍵小工具狀態 + 開啟憑證 URL。
- `scripts/termux-auth-widget.sh`：完整引導式小工具流程。
- `scripts/termux-sync-widget.sh`：同步 Claude Code 憑證至 OpenClaw。

如果您不需要手機自動化或 systemd 計時器，請跳過這些指令碼。
