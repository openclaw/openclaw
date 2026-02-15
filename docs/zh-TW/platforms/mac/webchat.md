---
summary: "macOS 應用程式如何嵌入 Gateway WebChat 以及如何偵錯"
read_when:
  - 偵錯 Mac WebChat 視圖或 local loopback 連接埠
title: "WebChat"
---

# WebChat (macOS 應用程式)

macOS 選單列應用程式將 WebChat UI 嵌入為原生 SwiftUI 視圖。它連接到 Gateway，並預設為所選智慧代理的**主要工作階段**（帶有工作階段切換器，可切換其他工作階段）。

- **Local mode**：直接連接到本機 Gateway WebSocket。
- **Remote mode**：透過 SSH 轉發 Gateway 控制連接埠，並將該通道用作資料平面。

## 啟動與偵錯

- 手動：Lobster 選單 → “Open Chat”。
- 自動開啟以供測試：

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- 紀錄：`./scripts/clawlog.sh`（子系統 `bot.molt`，類別 `WebChatSwiftUI`）。

## 內部連接方式

- 資料平面：Gateway WS 方法 `chat.history`、`chat.send`、`chat.abort`、`chat.inject` 以及事件 `chat`、`agent`、`presence`、`tick`、`health`。
- 工作階段：預設為主要工作階段（`main`，或在範圍為全域時為 `global`）。UI 可以在工作階段之間切換。
- 新手導覽使用專用工作階段來保持首次執行設定的獨立性。

## 安全性層面

- Remote mode 僅透過 SSH 轉發 Gateway WebSocket 控制連接埠。

## 已知限制

- UI 已針對聊天工作階段進行優化（而非完整的瀏覽器沙箱）。
