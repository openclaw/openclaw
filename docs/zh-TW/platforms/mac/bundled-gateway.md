---
summary: "Gateway 運行時於 macOS (外部 launchd 服務)"
read_when:
  - 打包 OpenClaw.app
  - 偵錯 macOS Gateway launchd 服務
  - 安裝 macOS 的 Gateway CLI
title: "Gateway 於 macOS"
---

# Gateway 於 macOS (外部 launchd)

OpenClaw.app 不再綑綁 Node/Bun 或 Gateway 運行時。macOS 應用程式需要一個 **外部** `openclaw` CLI 安裝，不會將 Gateway 作為子程序啟動，並管理一個每個使用者的 launchd 服務以保持 Gateway 運行 (或連接到一個已存在的本地 Gateway，如果已經在運行)。

## 安裝 CLI (本地模式所需)

您的 Mac 需要 Node 22+ 版本，然後全域安裝 `openclaw`：

```bash
npm install -g openclaw @<version>
```

macOS 應用程式的 **安裝 CLI** 按鈕透過 npm/pnpm 執行相同的流程 (不建議將 bun 用於 Gateway 運行時)。

## Launchd (Gateway 作為 LaunchAgent)

標籤：

- `bot.molt.gateway` (或 `bot.molt.<profile>`; 舊版 `com.openclaw.*` 可能保留)

Plist 位置 (每個使用者)：

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (或 `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

管理器：

- macOS 應用程式負責在本地模式下安裝/更新 LaunchAgent。
- CLI 也可以安裝它：`openclaw gateway install`。

行為：

- 「OpenClaw Active」會啟用/停用 LaunchAgent。
- 應用程式退出**不會**停止 Gateway (launchd 會保持其運行)。
- 如果 Gateway 已經在設定的埠上運行，應用程式會連接到它而不是啟動一個新的。

日誌：

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## 版本相容性

macOS 應用程式會檢查 Gateway 版本與其自身的版本。如果它們不相容，請更新全域 CLI 以符合應用程式版本。

## 冒煙測試

```bash
openclaw --version
```

```bash
OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

然後：

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
