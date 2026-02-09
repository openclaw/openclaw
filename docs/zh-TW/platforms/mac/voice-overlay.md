---
summary: "喚醒詞與按鍵通話重疊時的語音覆蓋層生命週期"
read_when:
  - 調整語音覆蓋層行為
title: "Voice Overlay"
---

# 語音覆蓋層生命週期（macOS）

Audience: macOS app contributors. Goal: keep the voice overlay predictable when wake-word and push-to-talk overlap.

## 目前意圖

- 如果覆蓋層已因喚醒詞而顯示，且使用者按下快捷鍵，快捷鍵工作階段會「接管（adopts）」既有文字，而不是重置它。 在按住快捷鍵期間，覆蓋層會持續顯示。 當使用者放開時：若有修剪後的文字則送出，否則關閉。
- 僅使用喚醒詞時仍會在靜默後自動送出；按鍵通話則在放開時立即送出。

## 已實作（2025 年 12 月 9 日）

- 覆蓋層工作階段現在每次擷取（喚醒詞或按住說話）都會攜帶一個權杖。 當權杖不相符時，會丟棄部分/最終/送出/關閉/音量更新，避免陳舊回呼。
- 按鍵通話會將任何可見的覆蓋層文字採用為前綴（因此在喚醒覆蓋層顯示時按下熱鍵，會保留文字並附加新的語音）。它最多等待 1.5 秒以取得最終逐字稿，否則回退使用目前文字。 在回退到目前文字前，最多等待 1.5 秒以取得最終轉錄。
- 提示音／覆蓋層記錄會在 `info` 輸出，分類為 `voicewake.overlay`、`voicewake.ptt` 與 `voicewake.chime`（工作階段開始、部分、最終、送出、關閉、提示音原因）。

## 後續步驟

1. **VoiceSessionCoordinator（actor）**
   - 任一時間僅擁有一個 `VoiceSession`。
   - API（以權杖為基礎）：`beginWakeCapture`、`beginPushToTalk`、`updatePartial`、`endCapture`、`cancel`、`applyCooldown`。
   - 丟棄攜帶陳舊權杖的回呼（防止舊的辨識器重新打開覆蓋層）。
2. **VoiceSession（模型）**
   - 欄位：`token`、`source`（wakeWord|pushToTalk）、已提交／揮發文字、提示音旗標、計時器（自動送出、閒置）、`overlayMode`（display|editing|sending）、冷卻截止時間。
3. **覆蓋層繫結**
   - `VoiceSessionPublisher`（`ObservableObject`）將作用中的工作階段映射到 SwiftUI。
   - `VoiceWakeOverlayView` 僅透過發布者進行渲染；不會直接變更全域單例。
   - 覆蓋層的使用者動作（`sendNow`、`dismiss`、`edit`）會帶著工作階段權杖回呼協調器。
4. **統一的送出路徑**
   - 在 `endCapture`：若修剪後文字為空 → 關閉；否則 `performSend(session:)`（僅播放一次送出提示音、轉送、關閉）。
   - 按鍵通話：不延遲；喚醒詞：可選擇延遲以自動送出。
   - 在按鍵通話完成後，對喚醒執行環境套用短暫冷卻，避免喚醒詞立即再次觸發。
5. **記錄**
   - 協調器在子系統 `bot.molt`、分類 `voicewake.overlay` 與 `voicewake.chime` 輸出 `.info` 記錄。
   - 關鍵事件：`session_started`、`adopted_by_push_to_talk`、`partial`、`finalized`、`send`、`dismiss`、`cancel`、`cooldown`。

## 偵錯檢查清單

- 在重現黏住的覆蓋層時串流記錄：

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 確認只有一個啟用中的工作階段權杖；陳舊回呼應由協調器丟棄。

- 確保按住說話放開時一定會以啟用中的權杖呼叫 `endCapture`；若文字為空，預期為 `dismiss`，不播放提示音也不送出。

## 遷移步驟（建議）

1. 新增 `VoiceSessionCoordinator`、`VoiceSession` 與 `VoiceSessionPublisher`。
2. 重構 `VoiceWakeRuntime`，改為建立／更新／結束工作階段，而非直接觸碰 `VoiceWakeOverlayController`。
3. 重構 `VoicePushToTalk`，以採用既有工作階段，並在放開時呼叫 `endCapture`；套用執行環境冷卻。
4. 將 `VoiceWakeOverlayController` 接線至發布者；移除執行環境／按鍵通話的直接呼叫。
5. 為工作階段接管、冷卻時間，以及空文字關閉新增整合測試。
