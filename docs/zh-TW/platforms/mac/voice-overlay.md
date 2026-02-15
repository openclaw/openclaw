---
summary: "當喚醒詞和即時語音重疊時，語音覆疊的生命週期"
read_when:
  - 調整語音覆疊行為時
title: "語音覆疊"
---

# 語音覆疊生命週期 (macOS)

受眾：macOS 應用程式貢獻者。目標：在喚醒詞和即時語音重疊時，使語音覆疊可預測。

## 當前意圖

- 如果語音覆疊已因喚醒詞而顯示，且使用者按下快速鍵，快速鍵工作階段會_採用_現有的文字，而非重設它。在按住快速鍵期間，語音覆疊會保持顯示。當使用者釋放時：如果有修剪過的文字則送出，否則關閉。
- 單獨使用喚醒詞仍會在靜默時自動送出；即時語音會在釋放時立即送出。

## 已實作 (2025 年 12 月 9 日)

- 語音覆疊工作階段現在每次擷取（喚醒詞或即時語音）都會帶有權杖。當權杖不匹配時，部分/最終/送出/關閉/等級更新會被捨棄，以避免過時的回呼。
- 即時語音會將任何可見的語音覆疊文字作為前綴（因此在喚醒覆疊顯示時按下快速鍵會保留文字並附加新的語音）。它會等待最多 1.5 秒以獲取最終轉錄，然後才回退到當前文字。
- 提示音/語音覆疊的日誌會以 `info` 等級在 `voicewake.overlay`、`voicewake.ptt` 和 `voicewake.chime` 類別中發出（工作階段開始、部分、最終、送出、關閉、提示音原因）。

## 後續步驟

1. **VoiceSessionCoordinator (智慧代理)**
   - 一次只擁有一個 `VoiceSession`。
   - API (基於權杖)：`beginWakeCapture`、`beginPushToTalk`、`updatePartial`、`endCapture`、`cancel`、`applyCooldown`。
   - 捨棄帶有過時權杖的回呼（防止舊的辨識器重新開啟語音覆疊）。
2. **VoiceSession (模型)**
   - 欄位：`token`、`source` (wakeWord|pushToTalk)、已提交/揮發性文字、提示音旗標、計時器（自動送出、閒置）、`overlayMode`（顯示|編輯|送出）、冷卻期限。
3. **語音覆疊繫結**
   - `VoiceSessionPublisher` (`ObservableObject`) 將活躍工作階段映照到 SwiftUI 中。
   - `VoiceWakeOverlayView` 僅透過發佈者進行渲染；它從不直接變異全域單例。
   - 語音覆疊使用者動作（`sendNow`、`dismiss`、`edit`）使用工作階段權杖回呼到協調器。
4. **統一送出路徑**
   - 在 `endCapture` 時：如果修剪過的文字為空 → 關閉；否則 `performSend(session:)`（播放一次送出提示音，轉發，關閉）。
   - 即時語音：無延遲；喚醒詞：自動送出可選延遲。
   - 在即時語音完成後，對喚醒執行時套用短暫冷卻，這樣喚醒詞就不會立即重新觸發。
5. **日誌記錄**
   - 協調器在子系統 `bot.molt` 的 `voicewake.overlay` 和 `voicewake.chime` 類別中發出 `.info` 日誌。
   - 關鍵事件：`session_started`、`adopted_by_to_talk`、`partial`、`finalized`、`send`、`dismiss`、`cancel`、`cooldown`。

## 偵錯檢查清單

- 在重現黏滯語音覆疊時，串流日誌：

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 驗證只有一個活躍的工作階段權杖；過時的回呼應由協調器捨棄。
- 確保即時語音釋放總是使用活躍權杖呼叫 `endCapture`；如果文字為空，預期 `dismiss` 不帶提示音或送出。

## 遷移步驟 (建議)

1. 新增 `VoiceSessionCoordinator`、`VoiceSession` 和 `VoiceSessionPublisher`。
2. 重構 `VoiceWakeRuntime` 以建立/更新/結束工作階段，而不是直接操作 `VoiceWakeOverlayController`。
3. 重構 `VoicePushToTalk` 以採用現有工作階段並在釋放時呼叫 `endCapture`；套用執行時冷卻。
4. 將 `VoiceWakeOverlayController` 連接到發佈者；移除執行時/PTT 的直接呼叫。
5. 新增用於工作階段採用、冷卻和空文字關閉的整合測試。
