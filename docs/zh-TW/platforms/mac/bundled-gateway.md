---
summary: Gateway runtime on macOS (external launchd service)
read_when:
  - Packaging OpenClaw.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: Gateway on macOS
---

# macOS 上的 Gateway（外部 launchd 啟動）

OpenClaw.app 不再內建 Node/Bun 或 Gateway 執行環境。macOS 應用程式
預期有一個**外部**`openclaw` CLI 安裝，不會以子程序方式啟動 Gateway，
而是管理每個使用者的 launchd 服務來保持 Gateway 執行（或在已有本地 Gateway 執行時附加至該 Gateway）。

## 安裝 CLI（本地模式必須）

Node 24 是 Mac 上的預設執行環境。Node 22 LTS，目前為 `22.16+`，仍可用於相容性。接著全域安裝 `openclaw`：

```bash
npm install -g openclaw@<version>
```

macOS 應用程式的 **安裝 CLI** 按鈕會透過 npm/pnpm 執行相同流程（不建議使用 bun 作為 Gateway 執行環境）。

## Launchd（Gateway 作為 LaunchAgent）

標籤：

- `ai.openclaw.gateway`（或 `ai.openclaw.<profile>`；舊版 `com.openclaw.*` 可能仍存在）

Plist 位置（每使用者）：

- `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  （或 `~/Library/LaunchAgents/ai.openclaw.<profile>.plist`）

管理者：

- macOS 應用程式負責本地模式下 LaunchAgent 的安裝/更新。
- CLI 也能安裝：`openclaw gateway install`。

行為：

- 「OpenClaw Active」用於啟用/停用 LaunchAgent。
- 應用程式退出**不會**停止 Gateway（launchd 會保持其執行）。
- 若在設定的埠口已有 Gateway 執行，應用程式會附加至該 Gateway，而非啟動新的。

記錄：

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## 版本相容性

macOS 應用程式會檢查 gateway 版本與自身版本是否相符。如果不相容，請更新全域 CLI 以符合應用程式版本。

## 簡易檢查

bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback

接著：

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
