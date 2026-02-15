---
summary: "當喚醒詞與一鍵通話重疊時的語音疊層生命週期"
read_when:
  - 調整語音疊層行為時
title: "語音疊層"
---

# 語音疊層生命週期 (macOS)

目標讀者：macOS 應用程式貢獻者。目標：在喚醒詞與一鍵通話重疊時，保持語音疊層的可預測性。

## 目前設計意圖

- 如果疊層已因喚醒詞而顯示，且使用者按下熱鍵，熱鍵工作階段會「承接」既有文字而非重置。熱鍵按下期間疊層保持顯示。當使用者放開時：若有修剪後的文字則傳送，否則關閉。
- 單純喚醒詞在靜音時仍會自動傳送；一鍵通話在放開時立即傳送。

## 已實作 (2025 年 12 月 9 日)

- 疊層工作階段現在每次擷取（喚醒詞或一鍵通話）都會帶有一個 Token。當 Token 不符時，部分/最終/傳送/關閉/音量更新會被捨棄，以避免過期的回呼。
- 一鍵通話會承接任何顯示中的疊層文字作為前綴（因此在喚醒疊層顯示時按下熱鍵，會保留文字並附加新的語音）。它會等待最多 1.5 秒以取得最終逐字稿，否則退而使用目前文字。
- 提示音/疊層日誌以 `info` 層級輸出於 `voicewake.overlay`、`voicewake.ptt` 及 `voicewake.chime` 類別中（包含工作階段開始、部分、最終、傳送、關閉、提示音原因）。

## 下一步

1. **VoiceSessionCoordinator (actor)**
   - 一次僅擁有一個 `VoiceSession`。
   - API (基於 Token)：`beginWakeCapture`、`beginPushToTalk`、`updatePartial`、`endCapture`、`cancel`、`applyCooldown`。
   - 捨棄帶有過期 Token 的回呼（防止舊的辨識器重新開啟疊層）。
2. **VoiceSession (model)**
   - 欄位：`token`、`source` (wakeWord|pushToTalk)、已提交/變動文字、提示音旗標、計時器 (自動傳送, 閒置)、`overlayMode` (顯示|編輯|傳送中)、冷卻截止時間。
3. **疊層繫結 (Overlay binding)**
   - `VoiceSessionPublisher` (`ObservableObject`) 將作用中的工作階段鏡射至 SwiftUI 中。
   - `VoiceWakeOverlayView` 僅透過發布者進行渲染；絕不直接修改全域單例。
   - 疊層使用者操作 (`sendNow`、`dismiss`、`edit`) 會帶著工作階段 Token 回呼至協調器。
4. **統一傳送路徑**
   - 在 `endCapture` 時：若修剪後的文字為空 → 關閉；否則執行 `performSend(session:)`（播放一次傳送提示音、轉發並關閉）。
   - 一鍵通話：無延遲；喚醒詞：可選擇是否為自動傳送進行延遲。
   - 在一鍵通話結束後，對喚醒執行環境套用短暫的冷卻時間，避免喚醒詞立即再次觸發。
5. **日誌 (Logging)**
   - 協調器在 `bot.molt` 子系統的 `voicewake.overlay` 與 `voicewake.chime` 類別中輸出 `.info` 日誌。
   - 關鍵事件：`session_started`、`adopted_by_push_to_talk`、`partial`、`finalized`、`send`、`dismiss`、`cancel`、`cooldown`。

## 偵錯檢查清單

- 重現疊層卡住問題時串流日誌：

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 驗證僅有一個作用中的工作階段 Token；過期的回呼應被協調器捨棄。
- 確保放開一鍵通話時一律使用作用中的 Token 呼叫 `endCapture`；若文字為空，預期會執行 `dismiss` 且不播放提示音或傳送。

## 遷移步驟 (建議)

1. 新增 `VoiceSessionCoordinator`、`VoiceSession` 與 `VoiceSessionPublisher`。
2. 重構 `VoiceWakeRuntime` 以建立/更新/結束工作階段，而非直接操作 `VoiceWakeOverlayController`。
3. 重構 `VoicePushToTalk` 以承接現有工作階段並在放開時呼叫 `endCapture`；套用執行環境冷卻時間。
4. 將 `VoiceWakeOverlayController` 連接至發布者；移除來自 runtime/PTT 的直接呼叫。
5. 為工作階段承接、冷卻時間與空文字關閉新增整合測試。
