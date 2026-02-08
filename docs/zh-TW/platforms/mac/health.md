---
summary: "macOS 應用程式如何回報 Gateway 閘道器／Baileys 的健康狀態"
read_when:
  - 偵錯 mac 應用程式健康指示器
title: "健康檢查"
x-i18n:
  source_path: platforms/mac/health.md
  source_hash: 0560e96501ddf53a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:43Z
---

# macOS 上的健康檢查

如何從選單列應用程式查看已連結頻道是否健康。

## 選單列

- 狀態圓點現在反映 Baileys 的健康狀態：
  - 綠色：已連結 + 近期已開啟 socket。
  - 橘色：連線中／重試中。
  - 紅色：已登出或探測失敗。
- 次要行顯示「linked · auth 12m」或顯示失敗原因。
- 「Run Health Check」選單項目會觸發隨選探測。

## 設定

- 一般分頁新增健康卡片，顯示：連結的 auth 年齡、session-store 路徑／數量、上次檢查時間、最近的錯誤／狀態碼，以及「Run Health Check」／「Reveal Logs」按鈕。
- 使用快取的快照，讓 UI 立即載入，離線時也能優雅回退。
- **Channels 分頁** 顯示 WhatsApp／Telegram 的頻道狀態與控制項（登入 QR、登出、探測、最近一次斷線／錯誤）。

## 探測如何運作

- 應用程式每約 60 秒以及在隨選時，透過 `ShellExecutor` 執行 `openclaw health --json`。探測會載入憑證並回報狀態，但不會傳送訊息。
- 分別快取「最後一次成功的快照」與「最後一次錯誤」，以避免畫面閃爍；並顯示各自的時間戳記。

## 不確定時

- 你仍可使用 [Gateway health](/gateway/health) 中的 CLI 流程（`openclaw status`、`openclaw status --deep`、`openclaw health --json`），並追蹤 `/tmp/openclaw/openclaw-*.log` 以查看 `web-heartbeat`／`web-reconnect`。
