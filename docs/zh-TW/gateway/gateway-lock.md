---
summary: "使用 WebSocket 接聽程式繫結的 Gateway 單一執行個體防護"
read_when:
  - 執行或偵錯 Gateway 程序時
  - 調查單一執行個體強制執行機制時
title: "Gateway Lock"
---

# Gateway lock

最後更新：2025-12-11

## 為何需要

- 確保同一主機上的每個基礎連接埠僅執行一個 Gateway 執行個體；額外的 Gateway 必須使用隔離的設定檔和唯一的連接埠。
- 在當機或 SIGKILL 中存續，且不留下過期的鎖定檔案。
- 當控制連接埠已被佔用時，透過明確的錯誤訊息快速失敗。

## 機制

- Gateway 在啟動時會立即使用獨佔的 TCP 接聽程式繫結 WebSocket 接聽程式（預設為 `ws://127.0.0.1:18789`）。
- 如果繫結失敗並出現 `EADDRINUSE`，啟動時會拋出 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 作業系統會在任何程序結束時自動釋放接聽程式，包括當機和 SIGKILL，因此不需要獨立的鎖定檔案或清理步驟。
- 關機時，Gateway 會關閉 WebSocket 伺服器和底層 HTTP 伺服器，以便及時釋放連接埠。

## 錯誤範圍

- 如果另一個程序佔用了連接埠，啟動時會拋出 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 其他繫結失敗則會顯示為 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`。

## 操作說明

- 如果連接埠被「另一個」程序佔用，錯誤訊息是一樣的；請釋放該連接埠，或使用 `openclaw gateway --port <port>` 選擇其他連接埠。
- macOS 應用程式在產生 Gateway 之前仍會維護其自身的輕量級 PID 保護；執行階段鎖定則是透過 WebSocket 繫結來強制執行的。
