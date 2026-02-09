---
summary: "macOS 上的 Gateway 執行環境（外部 launchd 服務）"
read_when:
  - 封裝 OpenClaw.app
  - 偵錯 macOS 的 Gateway launchd 服務
  - 為 macOS 安裝 Gateway CLI
title: "macOS 上的 Gateway"
---

# macOS 上的 Gateway（外部 launchd）

OpenClaw.app 不再內建 Node/Bun 或閘道執行環境。 OpenClaw.app 不再內建 Node/Bun 或 Gateway 執行環境。macOS 應用程式
預期安裝**外部**的 `openclaw` CLI，不會將 Gateway 作為子行程啟動，
而是管理每位使用者的 launchd 服務以保持 Gateway 持續執行
（或在本機已有 Gateway 正在執行時附加至該 Gateway）。

## 安裝 CLI（本機模式必需）

你需要在 Mac 上安裝 Node 22+，接著全域安裝 `openclaw`：

```bash
npm install -g openclaw@<version>
```

macOS 應用程式的 **Install CLI** 按鈕會透過 npm/pnpm 執行相同流程（不建議使用 bun 作為 Gateway 執行環境）。

## Launchd（Gateway 作為 LaunchAgent）

標籤：

- `bot.molt.gateway`（或 `bot.molt.<profile>`；舊版 `com.openclaw.*` 可能仍存在）

Plist 位置（每位使用者）：

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  （或 `~/Library/LaunchAgents/bot.molt.<profile>.plist`）

管理方式：

- macOS 應用程式在本機模式下負責 LaunchAgent 的安裝與更新。
- CLI 也可以進行安裝：`openclaw gateway install`。

行為：

- 「OpenClaw Active」可啟用或停用 LaunchAgent。
- 關閉應用程式**不會**停止 Gateway（launchd 會維持其運行）。
- 若在設定的連接埠上已有 Gateway 正在執行，應用程式會附加至該 Gateway，而非啟動新的實例。

記錄：

- launchd stdout/err：`/tmp/openclaw/openclaw-gateway.log`

## 版本相容性

macOS App 會檢查閘道版本是否與自身版本一致。 若它們
不相容，請更新全域 CLI 以符合 App 版本。

## 煙霧測試

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

然後：

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
