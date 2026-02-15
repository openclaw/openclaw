---
summary: "macOS 應用程式如何回報 Gateway/Baileys 健康狀態"
read_when:
  - 偵錯 Mac 應用程式的健康指標時
title: "健康檢查"
---

# 於 macOS 上的健康檢查

如何從選單列應用程式查看已連結的頻道是否健康。

## 選單列

- 狀態點現在反映 Baileys 健康狀態：
  - 綠色：已連結 + socket 最近已開啟。
  - 橘色：正在連線/重試中。
  - 紅色：已登出或探測失敗。
- 第二行顯示 "linked · auth 12m" 或顯示失敗原因。
- 「執行健康檢查」選單項目會觸發隨選探測。

## 設定

- 一般分頁新增一個健康狀況卡片，顯示：已連結憑證時長、工作階段儲存路徑/計數、上次檢查時間、上次錯誤/狀態碼，以及「執行健康檢查 / 顯示日誌」按鈕。
- 使用快取快照，因此使用者介面可立即載入，並在離線時優雅地降級。
- **頻道分頁**顯示頻道狀態 + WhatsApp/Telegram 的控制項（登入 QR、登出、探測、上次斷線/錯誤）。

## 探測如何運作

- 應用程式透過 `ShellExecutor` 每約 60 秒及隨選執行 `openclaw health --json`。探測會載入憑證並回報狀態，而不傳送訊息。
- 分別快取上次良好快照和上次錯誤，以避免閃爍；顯示各自的時間戳記。

## 如有疑問

- 您仍然可以使用 [Gateway 健康狀況](/gateway/health) 中的 CLI 流程 (`openclaw status`、`openclaw status --deep`、`openclaw health --json`)，並追蹤 `/tmp/openclaw/openclaw-*.log` 以查看 `web-heartbeat` / `web-reconnect`。
