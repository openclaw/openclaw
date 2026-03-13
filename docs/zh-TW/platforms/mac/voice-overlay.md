---
summary: Voice overlay lifecycle when wake-word and push-to-talk overlap
read_when:
  - Adjusting voice overlay behavior
title: Voice Overlay
---

# 語音覆蓋生命週期（macOS）

目標讀者：macOS 應用程式貢獻者。目標：當喚醒詞與按鍵說話重疊時，保持語音覆蓋的行為可預期。

## 目前意圖

- 如果覆蓋層已因喚醒詞顯示，且使用者按下熱鍵，熱鍵會 _採用_ 現有文字而非重置。只要熱鍵持續按下，覆蓋層就會保持顯示。使用者放開時：若有修剪後的文字則送出，否則關閉覆蓋層。
- 喚醒詞單獨使用時仍會在靜音時自動送出；按鍵說話則在放開時立即送出。

## 已實作（2025年12月9日）

- 覆蓋層會話現在每次擷取（喚醒詞或按鍵說話）都帶有一個 token。當 token 不符時，部分/最終/送出/關閉/音量更新的回調會被丟棄，避免過時回調。
- 按鍵說話會採用任何可見的覆蓋文字作為前綴（因此在喚醒詞覆蓋層顯示時按熱鍵，會保留文字並附加新語音）。它會等待最多 1.5 秒的最終轉錄，若無則回退使用當前文字。
- 鈴聲與覆蓋層日誌會在 `info` 發出，分類為 `voicewake.overlay`、`voicewake.ptt` 和 `voicewake.chime`（會話開始、部分、最終、送出、關閉、鈴聲原因）。

## 下一步

1. **VoiceSessionCoordinator（actor）**
   - 同時擁有且管理唯一一個 `VoiceSession`。
   - API（基於 token）：`beginWakeCapture`、`beginPushToTalk`、`updatePartial`、`endCapture`、`cancel`、`applyCooldown`。
   - 丟棄帶有過時 token 的回調（防止舊辨識器重新開啟覆蓋層）。
2. **VoiceSession（模型）**
   - 欄位：`token`、`source`（wakeWord|pushToTalk）、已提交/暫存文字、鈴聲旗標、計時器（自動送出、閒置）、`overlayMode`（顯示中|編輯中|送出中）、冷卻截止時間。
3. **覆蓋層綁定**
   - `VoiceSessionPublisher`（`ObservableObject`）將活動會話鏡像到 SwiftUI。
   - `VoiceWakeOverlayView` 僅透過 publisher 呈現；不直接修改全域 singleton。
   - 覆蓋層使用者操作（`sendNow`、`dismiss`、`edit`）會帶著會話 token 回調給 coordinator。
4. **統一送出流程**
   - 在 `endCapture`：若修剪後文字為空 → 關閉覆蓋層；否則 `performSend(session:)`（播放送出鈴聲一次、轉發、關閉覆蓋層）。
   - 按鍵說話：無延遲；喚醒詞：可選延遲自動送出。
   - 按鍵說話結束後，對喚醒詞執行短暫冷卻，避免喚醒詞立即重新觸發。
5. **日誌紀錄**
   - Coordinator 在子系統 `ai.openclaw` 發出 `.info` 日誌，分類為 `voicewake.overlay` 和 `voicewake.chime`。
   - 重要事件：`session_started`、`adopted_by_push_to_talk`、`partial`、`finalized`、`send`、`dismiss`、`cancel`、`cooldown`。

## 除錯檢查清單

- 在重現覆蓋層卡住時，串流日誌：

```bash
  sudo log stream --predicate 'subsystem == "ai.openclaw" AND category CONTAINS "voicewake"' --level info --style compact
```

- 確認只有一個有效的會話 token；過時回調應由 coordinator 丟棄。
- 確保按鍵說話放開時總是呼叫 `endCapture` 並帶入有效 token；若文字為空，預期呼叫 `dismiss`，且不播放鈴聲或送出。

## 遷移步驟（建議）

1. 新增 `VoiceSessionCoordinator`、`VoiceSession` 和 `VoiceSessionPublisher`。
2. 重構 `VoiceWakeRuntime`，改為建立/更新/結束會話，而非直接操作 `VoiceWakeOverlayController`。
3. 重構 `VoicePushToTalk`，採用現有會話並在放開時呼叫 `endCapture`；套用執行時冷卻。
4. 將 `VoiceWakeOverlayController` 連接到 publisher；移除 runtime/PTT 的直接呼叫。
5. 新增整合測試，涵蓋會話採用、冷卻與空文字關閉。
