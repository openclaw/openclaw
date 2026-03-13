---
summary: How the macOS app reports gateway/Baileys health states
read_when:
  - Debugging mac app health indicators
title: Health Checks
---

# macOS 上的健康檢查

如何從選單列應用程式查看連結頻道是否健康。

## 選單列

- 狀態點現在反映 Baileys 的健康狀態：
  - 綠色：已連結且最近已開啟 socket。
  - 橘色：正在連線/重試中。
  - 紅色：已登出或探測失敗。
- 次要行顯示「linked · auth 12m」或顯示失敗原因。
- 「執行健康檢查」選單專案會觸發即時探測。

## 設定

- 一般標籤新增健康卡片，顯示：連結認證時間、會話存儲路徑/數量、最後檢查時間、最後錯誤/狀態碼，以及執行健康檢查 / 顯示日誌的按鈕。
- 使用快取快照，讓 UI 立即載入，離線時也能優雅回退。
- **頻道標籤** 顯示頻道狀態及 WhatsApp/Telegram 的控制項（登入 QR、登出、探測、最後斷線/錯誤）。

## 探測運作方式

- 應用程式每約 60 秒及按需透過 `ShellExecutor` 執行 `openclaw health --json`。探測會載入憑證並回報狀態，但不會發送訊息。
- 分別快取最後一次成功快照與最後一次錯誤，避免閃爍；並顯示各自的時間戳。

## 有疑慮時

- 你仍可使用 CLI 流程於 [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`)，並監控 `/tmp/openclaw/openclaw-*.log` 以查看 `web-heartbeat` / `web-reconnect`。
