---
summary: "mac 應用程式如何內嵌 Gateway WebChat 以及如何進行除錯"
read_when:
  - 除錯 mac WebChat 檢視或 loopback 連接埠
title: "WebChat"
---

# WebChat（macOS 應用程式）

macOS 選單列應用程式將 WebChat UI 以原生 SwiftUI 檢視嵌入。 它
連線至 Gateway，並預設使用所選代理的 **主要工作階段**
（另有工作階段切換器可切換其他工作階段）。

- **本機模式**：直接連線至本機 Gateway 閘道器 WebSocket 連線。
- **遠端模式**：透過 SSH 轉送 Gateway 閘道器控制連接埠，並將該通道作為資料平面使用。

## 啟動與除錯

- 手動：Lobster 選單 → 「Open Chat」。

- 測試用自動開啟：

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- 記錄：`./scripts/clawlog.sh`（子系統 `bot.molt`，分類 `WebChatSwiftUI`）。

## How it’s wired

- 資料平面：Gateway WS 方法 `chat.history`、`chat.send`、`chat.abort`、
  `chat.inject`，以及事件 `chat`、`agent`、`presence`、`tick`、`health`。
- 工作階段：預設為主要工作階段（`main`，或在全域範圍時為 `global`）。 The UI can switch between sessions.
- Onboarding uses a dedicated session to keep first‑run setup separate.

## 安全性範圍

- 遠端模式僅透過 SSH 轉送 Gateway 閘道器 WebSocket 控制連接埠。

## 已知限制

- UI 針對聊天工作階段最佳化（並非完整的瀏覽器沙箱）。
