---
summary: "如何在 macOS 應用程式中嵌入 Gateway WebChat 以及如何進行偵錯"
read_when:
  - 偵錯 macOS WebChat 視圖或 loopback 埠
title: "WebChat"
---

# WebChat (macOS 應用程式)

macOS 選單列應用程式將 WebChat UI 嵌入為原生的 SwiftUI 視圖。它會連線到 Gateway，並預設為所選智慧代理的**主要工作階段**（並提供工作階段切換器來切換至其他工作階段）。

- **本地模式**：直接連線到本地 Gateway WebSocket。
- **遠端模式**：透過 SSH 轉發 Gateway 控制埠，並將該通道作為資料平面使用。

## 啟動與偵錯

- 手動：Lobster 選單 → “Open Chat”。
- 測試用的自動開啟：

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- 紀錄：`./scripts/clawlog.sh`（子系統 `bot.molt`，類別 `WebChatSwiftUI`）。

## 運作機制

- 資料平面：Gateway WS 方法 `chat.history`, `chat.send`, `chat.abort`, `chat.inject` 以及事件 `chat`, `agent`, `presence`, `tick`, `health`。
- 工作階段：預設為主要工作階段（`main`，或當範圍為 global 時則為 `global`）。UI 可以切換不同的工作階段。
- 新手導覽使用專屬的工作階段，以確保首次執行的設定程序保持獨立。

## 安全層面

- 遠端模式僅透過 SSH 轉發 Gateway WebSocket 控制埠。

## 已知限制

- UI 針對對話工作階段進行了最佳化（並非完整的瀏覽器沙箱）。
