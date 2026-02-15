---
summary: "macOS 應用程式如何回報 Gateway/Baileys 的健康狀態"
read_when:
  - "對 Mac 應用程式的健康指標進行除錯時"
title: "健康檢查"
---

# macOS 上的健康檢查

如何從選單列應用程式查看已連結的頻道是否健康。

## 選單列

- 狀態點現在會反映 Baileys 的健康狀況：
  - 綠色：已連結 + 最近已開啟 socket。
  - 橘色：正在連線/重試中。
  - 紅色：已登出或偵測失敗。
- 第二行顯示「linked · auth 12m」或顯示失敗原因。
- 「Run Health Check」選單項目可觸發隨選偵測。

## 設定

- 「一般」分頁新增了健康檢查卡片，顯示：連結認證時間、工作階段儲存路徑/數量、最後檢查時間、最後錯誤/狀態碼，以及 Run Health Check / Reveal Logs 按鈕。
- 使用快照快取，讓 UI 能即時載入，並在離線時優雅降級。
- **頻道分頁**顯示頻道狀態以及 WhatsApp/Telegram 的控制選項（登入 QR code、登出、偵測、最後斷線原因/錯誤）。

## 偵測運作方式

- 應用程式每約 60 秒及在有需求時，會透過 `ShellExecutor` 執行 `openclaw health --json`。此偵測會載入憑證並回報狀態，而不會發送訊息。
- 分別快取最後一次正常的快照與最後一次的錯誤以避免畫面閃爍；並顯示各自的時間戳記。

## 若有疑問

- 您仍然可以使用 [Gateway 健康檢查](/gateway/health) 中的 CLI 流程（`openclaw status`、`openclaw status --deep`、`openclaw health --json`），並監控 `/tmp/openclaw/openclaw-*.log` 中的 `web-heartbeat` / `web-reconnect` 資訊。
