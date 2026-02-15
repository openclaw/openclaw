---
summary: "使用 WebSocket 監聽器繫結的 Gateway 單例保護"
read_when:
  - 執行或偵錯 Gateway 程序
  - 調查單一實例強制執行
title: "Gateway 鎖定"
---

# Gateway 鎖定

上次更新：2025-12-11

## 原因

- 確保在同一主機上每個基礎埠僅執行一個 Gateway 實例；額外的 Gateway 必須使用獨立的設定檔和唯一的埠。
- 在崩潰/SIGKILL 後不會留下過時的鎖定檔案。
- 當控制埠已被佔用時，快速失敗並顯示明確錯誤。

## 機制

- Gateway 會在啟動時立即使用獨佔 TCP 監聽器繫結 WebSocket 監聽器（預設為 `ws://127.0.0.1:18789`）。
- 如果繫結因 `EADDRINUSE` 失敗，啟動會拋出 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 作業系統會在任何程序退出時（包括崩潰和 SIGKILL）自動釋放監聽器—無需獨立的鎖定檔案或清理步驟。
- 關閉時，Gateway 會關閉 WebSocket 伺服器和底層 HTTP 伺服器以即時釋放埠。

## 錯誤表面

- 如果另一個程序佔用該埠，啟動會拋出 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 其他繫結失敗會顯示為 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`。

## 操作說明

- 如果該埠被「另一個」程序佔用，錯誤訊息會相同；請釋放該埠或使用 `openclaw gateway --port <port>` 選擇另一個埠。
- macOS 應用程式在啟動 Gateway 之前仍維持其輕量級 PID 守護；執行時鎖定由 WebSocket 繫結強制執行。
