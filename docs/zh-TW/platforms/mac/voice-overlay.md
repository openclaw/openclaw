---
summary: 「喚醒詞與按鍵通話重疊時的語音覆蓋層生命週期」
read_when:
  - 調整語音覆蓋層行為
title: 「語音覆蓋層」
x-i18n:
  source_path: platforms/mac/voice-overlay.md
  source_hash: 5d32704c412295c2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:53Z
---

# 語音覆蓋層生命週期（macOS）

受眾：macOS 應用程式貢獻者。目標：在喚醒詞與按鍵通話重疊時，讓語音覆蓋層行為可預期。

## 目前意圖

- 若覆蓋層已因喚醒詞顯示，且使用者按下熱鍵，熱鍵工作階段會「採用」既有文字而非重設。覆蓋層在按住熱鍵期間保持顯示。使用者放開時：若有修剪後文字則送出，否則關閉。
- 僅使用喚醒詞時仍會在靜默後自動送出；按鍵通話則在放開時立即送出。

## 已實作（2025 年 12 月 9 日）

- 覆蓋層工作階段現在為每次擷取（喚醒詞或按鍵通話）攜帶一個權杖。當權杖不相符時，部分／最終／送出／關閉／音量更新會被丟棄，以避免過期回呼。
- 按鍵通話會將任何可見的覆蓋層文字採用為前綴（因此在喚醒覆蓋層顯示時按下熱鍵，會保留文字並附加新的語音）。它最多等待 1.5 秒以取得最終逐字稿，否則回退使用目前文字。
- 提示音／覆蓋層記錄會在 `info` 輸出，分類為 `voicewake.overlay`、`voicewake.ptt` 與 `voicewake.chime`（工作階段開始、部分、最終、送出、關閉、提示音原因）。

## 後續步驟

1. **VoiceSessionCoordinator（actor）**
   - 任一時間僅擁有一個 `VoiceSession`。
   - API（以權杖為基礎）：`beginWakeCapture`、`beginPushToTalk`、`updatePartial`、`endCapture`、`cancel`、`applyCooldown`。
   - 丟棄攜帶過期權杖的回呼（避免舊的辨識器重新打開覆蓋層）。
2. **VoiceSession（模型）**
   - 欄位：`token`、`source`（wakeWord|pushToTalk）、已提交／揮發文字、提示音旗標、計時器（自動送出、閒置）、`overlayMode`（display|editing|sending）、冷卻截止時間。
3. **覆蓋層繫結**
   - `VoiceSessionPublisher`（`ObservableObject`）將作用中的工作階段映射到 SwiftUI。
   - `VoiceWakeOverlayView` 僅透過發布者進行渲染；不會直接變更全域單例。
   - 覆蓋層使用者動作（`sendNow`、`dismiss`、`edit`）會以工作階段權杖回呼協調器。
4. **統一的送出路徑**
   - 在 `endCapture`：若修剪後文字為空 → 關閉；否則 `performSend(session:)`（僅播放一次送出提示音、轉送、關閉）。
   - 按鍵通話：不延遲；喚醒詞：可選擇延遲以自動送出。
   - 在按鍵通話完成後，對喚醒執行環境套用短暫冷卻，避免喚醒詞立即再次觸發。
5. **記錄**
   - 協調器在子系統 `bot.molt`、分類 `voicewake.overlay` 與 `voicewake.chime` 輸出 `.info` 記錄。
   - 關鍵事件：`session_started`、`adopted_by_push_to_talk`、`partial`、`finalized`、`send`、`dismiss`、`cancel`、`cooldown`。

## 偵錯檢查清單

- 在重現覆蓋層卡住問題時串流記錄：

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 確認僅有一個作用中的工作階段權杖；過期回呼應由協調器丟棄。
- 確保按鍵通話放開時一定會以作用中的權杖呼叫 `endCapture`；若文字為空，預期會呼叫 `dismiss`，且不播放提示音或送出。

## 遷移步驟（建議）

1. 新增 `VoiceSessionCoordinator`、`VoiceSession` 與 `VoiceSessionPublisher`。
2. 重構 `VoiceWakeRuntime`，改為建立／更新／結束工作階段，而非直接觸碰 `VoiceWakeOverlayController`。
3. 重構 `VoicePushToTalk`，以採用既有工作階段，並在放開時呼叫 `endCapture`；套用執行環境冷卻。
4. 將 `VoiceWakeOverlayController` 接線至發布者；移除執行環境／按鍵通話的直接呼叫。
5. 為工作階段採用、冷卻與空文字關閉新增整合測試。
