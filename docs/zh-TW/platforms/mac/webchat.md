---
summary: How the mac app embeds the gateway WebChat and how to debug it
read_when:
  - Debugging mac WebChat view or loopback port
title: WebChat
---

# WebChat（macOS 應用程式）

macOS 選單列應用程式將 WebChat UI 嵌入為原生 SwiftUI 視圖。它連接到 Gateway，並預設使用所選代理的**主要會話**（並提供會話切換器以切換其他會話）。

- **本地模式**：直接連接到本地 Gateway WebSocket。
- **遠端模式**：透過 SSH 轉發 Gateway 控制埠，並使用該通道作為資料平面。

## 啟動與除錯

- 手動：Lobster 選單 →「開啟聊天」。
- 測試時自動開啟：

```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
```

- 日誌：`./scripts/clawlog.sh`（子系統 `ai.openclaw`，類別 `WebChatSwiftUI`）。

## 連接架構

- 資料平面：Gateway WS 方法 `chat.history`、`chat.send`、`chat.abort`、`chat.inject` 及事件 `chat`、`agent`、`presence`、`tick`、`health`。
- 會話：預設為主要會話（`main`，或在全域範圍時為 `global`）。UI 可在會話間切換。
- 新手引導使用專用會話，以保持首次設定獨立。

## 安全面向

- 遠端模式僅透過 SSH 轉發 Gateway WebSocket 控制埠。

## 已知限制

- UI 針對聊天會話進行優化（非完整瀏覽器沙箱）。
