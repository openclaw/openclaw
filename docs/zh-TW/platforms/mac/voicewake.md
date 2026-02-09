---
summary: "mac 應用程式中的語音喚醒與按鍵通話模式，以及轉送路由細節"
read_when:
  - 進行語音喚醒或 PTT 流程相關工作時
title: "語音喚醒"
---

# 語音喚醒 & 按鍵通話

## 模式

- **喚醒詞模式**（預設）：常駐的語音辨識器等待觸發詞（`swabbleTriggerWords`）。一旦比對成功便開始擷取，顯示含部分文字的疊加層，並在靜默後自動送出。 On match it starts capture, shows the overlay with partial text, and auto-sends after silence.
- **Push-to-talk (Right Option hold)**: hold the right Option key to capture immediately—no trigger needed. 按住期間顯示覆蓋層；放開後會在短暫延遲後完成並轉送，讓你能微調文字。

## 執行期行為（喚醒詞）

- 語音辨識器位於 `VoiceWakeRuntime`。
- 只有在喚醒詞與下一個詞之間存在**有意義的停頓**（約 0.55 秒間隔）時才會觸發。 覆蓋層／提示音可在停頓時就開始，即使指令尚未開始。
- 靜默視窗：語音連續時為 2.0 秒；若只聽到觸發詞則為 5.0 秒。
- 強制停止：120 秒，以防止工作階段失控。
- 工作階段之間的去彈跳：350ms。
- 疊加層透過 `VoiceWakeOverlayController` 驅動，使用已提交／暫態的著色。
- 送出後，辨識器會乾淨地重新啟動以聆聽下一次觸發。

## Lifecycle invariants

- 若已啟用語音喚醒且權限齊備，喚醒詞辨識器應持續聆聽（除非正在進行明確的按鍵通話擷取）。
- 覆蓋層的可見性（包括透過 X 按鈕手動關閉）絕不可阻止辨識器恢復。

## 疊加層卡住的失敗模式（先前）

先前若覆蓋層卡住顯示且你手動關閉，語音喚醒可能看起來「失效」，因為執行期的重新啟動嘗試可能被覆蓋層可見性阻擋，且未排程後續重新啟動。

強化：

- 喚醒執行期的重新啟動不再受疊加層可見性阻擋。
- 疊加層關閉完成會透過 `VoiceSessionCoordinator` 觸發 `VoiceWakeRuntime.refresh(...)`，因此手動點 X 關閉一定會恢復聆聽。

## 按住說話細節

- 快捷鍵偵測使用全域的 `.flagsChanged` 監聽器來監控**右 Option**（`keyCode 61` + `.option`）。僅觀察事件（不攔截）。 我們只觀察事件（不吞噬）。
- 擷取管線位於 `VoicePushToTalk`：立即啟動語音，將部分結果串流至疊加層，並在放開時呼叫 `VoiceWakeForwarder`。
- 當按鍵通話開始時，我們會暫停喚醒詞執行期以避免音訊擷取衝突；放開後會自動重新啟動。
- 權限：需要麥克風 + 語音；要看到事件需核准輔助使用／輸入監控。
- 外接鍵盤：部分鍵盤可能未如預期暴露右 Option——若使用者回報漏偵，請提供備用快捷鍵。

## 使用者可見設定

- **語音喚醒** 開關：啟用喚醒詞執行期。
- **按住 Cmd+Fn 說話**：啟用按住說話監控。 在 macOS < 26 上停用。
- 語言與麥克風選擇器、即時音量表、觸發詞表、測試器（僅本地；不轉送）。
- 若裝置斷線，麥克風選擇器會保留最後的選擇、顯示斷線提示，並在裝置返回前暫時回退到系統預設。
- **音效**：在觸發偵測與送出時播放提示音；預設為 macOS 的「Glass」系統音效。你可為每個事件選擇任何可由 `NSSound` 載入的檔案（例如 MP3/WAV/AIFF），或選擇 **無音效**。 You can pick any `NSSound`-loadable file (e.g. MP3/WAV/AIFF) for each event or choose **No Sound**.

## 轉送行為

- 啟用語音喚醒時，逐字稿會轉送至目前的 gateway／agent（與 mac 應用程式其餘部分使用相同的本機 vs 遠端模式）。
- Replies are delivered to the **last-used main provider** (WhatsApp/Telegram/Discord/WebChat). 若傳遞失敗，錯誤會被記錄，且仍可透過 WebChat／工作階段記錄看到該次執行。

## 轉送負載

- `VoiceWakeForwarder.prefixedTranscript(_:)` 會在送出前加上機器提示。喚醒詞與按鍵通話流程共用。 Shared between wake-word and push-to-talk paths.

## 快速驗證

- Toggle push-to-talk on, hold Cmd+Fn, speak, release: overlay should show partials then send.
- 按住期間，選單列的耳朵應保持放大（使用 `triggerVoiceEars(ttl:nil)`）；放開後恢復。
