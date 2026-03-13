---
summary: Gateway singleton guard using the WebSocket listener bind
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
title: Gateway Lock
---

# Gateway lock

最後更新：2025-12-11

## 為什麼

- 確保每個主機上的基礎埠僅執行一個閘道實例；額外的閘道必須使用隔離的設定檔和唯一的埠。
- 在崩潰/SIGKILL 的情況下生存，並且不留下過時的鎖定檔案。
- 當控制埠已被佔用時，快速失敗並顯示明確的錯誤。

## 機制

- 閘道在啟動時立即使用獨佔的 TCP 監聽器綁定 WebSocket 監聽器（預設 `ws://127.0.0.1:18789`）。
- 如果綁定失敗，則啟動會拋出 `EADDRINUSE` 和 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 作業系統會在任何進程退出時自動釋放監聽器，包括崩潰和 SIGKILL—不需要單獨的鎖定檔或清理步驟。
- 在關閉時，閘道會關閉 WebSocket 伺服器和底層的 HTTP 伺服器，以便迅速釋放端口。

## Error surface

- 如果另一個進程佔用了該端口，啟動會拋出 `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`。
- 其他綁定失敗會顯示為 `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`。

## 操作說明

- 如果該埠被 _其他_ 程序佔用，錯誤是相同的；請釋放該埠或選擇另一個埠 `openclaw gateway --port <port>`。
- macOS 應用程式在啟動網關之前仍然維護自己的輕量級 PID 保護；執行時鎖定是由 WebSocket 綁定強制執行的。
