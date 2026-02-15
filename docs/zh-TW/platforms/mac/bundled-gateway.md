---
summary: "Gateway 在 macOS 上的執行階段（外部 launchd 服務）"
read_when:
  - 打包 OpenClaw.app 時
  - 對 macOS Gateway launchd 服務進行除錯時
  - 為 macOS 安裝 Gateway CLI 時
title: "macOS 上的 Gateway"
---

# macOS 上的 Gateway (外部 launchd)

OpenClaw.app 不再內建 Node/Bun 或 Gateway 執行階段。macOS 應用程式預期有一個**外部**的 `openclaw` CLI 安裝，它不會將 Gateway 作為子程序啟動，而是管理一個針對個別使用者的 launchd 服務來維持 Gateway 運作（或者如果已有本地 Gateway 在執行中，則會與其連接）。

## 安裝 CLI (本地模式必備)

您的 Mac 需要安裝 Node 22+，然後全域安裝 `openclaw`：

```bash
npm install -g openclaw @<version>
```

macOS 應用程式的 **Install CLI** 按鈕會透過 npm/pnpm 執行相同的流程（Gateway 執行階段不建議使用 bun）。

## Launchd (將 Gateway 作為 LaunchAgent)

標籤：

- `bot.molt.gateway` (或 `bot.molt.<profile>`；可能仍存在舊版的 `com.openclaw.*`)

Plist 路徑 (個別使用者)：

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (或 `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

管理程式：

- 在本地模式下，macOS 應用程式負責 LaunchAgent 的安裝與更新。
- CLI 也可以安裝它：`openclaw gateway install`。

行為：

- 「OpenClaw Active」可啟用或停用 LaunchAgent。
- 應用程式結束**不會**停止 Gateway (launchd 會維持其運作)。
- 如果已有 Gateway 在設定的連接埠執行，應用程式會直接連接，而不是啟動新的 Gateway。

日誌：

- launchd 標準輸出/錯誤：`/tmp/openclaw/openclaw-gateway.log`

## 版本相容性

macOS 應用程式會檢查 Gateway 版本與其自身版本的相容性。如果不相容，請更新全域 CLI 以符合應用程式版本。

## 安裝完整性檢查

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

接著執行：

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
