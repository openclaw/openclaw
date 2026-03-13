---
summary: "Image and media handling rules for send, gateway, and agent replies"
read_when:
  - Modifying media pipeline or attachments
title: Image and Media Support
---

# 圖像與媒體支援 — 2025-12-05

WhatsApp 頻道透過 **Baileys Web** 運作。本文檔記錄目前媒體處理規則，涵蓋發送、閘道與客服回覆。

## 目標

- 透過 `openclaw message send --media` 發送帶有可選說明文字的媒體。
- 允許網頁收件匣的自動回覆同時包含媒體與文字。
- 保持各類型限制合理且可預期。

## CLI 介面

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` 為選填；說明文字可留空以僅發送媒體。
  - `--dry-run` 輸出解析後的負載；`--json` 會觸發 `{ channel, to, messageId, mediaUrl, caption }`。

## WhatsApp Web 頻道行為

- 輸入：本地檔案路徑 **或** HTTP(S) URL。
- 流程：載入為 Buffer，偵測媒體類型，並建立正確的負載：
  - **圖片：** 調整大小並重新壓縮為 JPEG（最大邊長 2048px），目標大小為 `agents.defaults.mediaMaxMb`（預設 5 MB），上限為 6 MB。
  - **音訊/語音/影片：** 直接通過，最大 16 MB；音訊以語音訊息形式發送 (`ptt: true`)。
  - **文件：** 其他類型，最大 100 MB，若有檔名則保留。
- WhatsApp GIF 風格播放：發送帶有 `gifPlayback: true` 的 MP4（CLI：`--gif-playback`），讓行動端用戶端可內嵌循環播放。
- MIME 偵測優先使用魔術位元組，再用標頭，最後才是副檔名。
- 說明文字來源為 `--message` 或 `reply.text`；允許說明文字為空。
- 紀錄：非詳細模式顯示 `↩️`/`✅`；詳細模式則包含大小與來源路徑/URL。

## 自動回覆流程

- `getReplyFromConfig` 回傳 `{ text?, mediaUrl?, mediaUrls? }`。
- 若有媒體，網頁發送端會使用與 `openclaw message send` 相同的流程解析本地路徑或 URL。
- 若提供多個媒體專案，會依序發送。

## 傳入媒體至指令 (Pi)

- 當傳入的網頁訊息包含媒體時，OpenClaw 會下載至暫存檔並暴露模板變數：
  - `{{MediaUrl}}` 傳入媒體的偽 URL。
  - `{{MediaPath}}` 在執行指令前寫入的本地暫存路徑。
- 若啟用每次會話的 Docker 沙箱，傳入媒體會被複製到沙箱工作區，且 `MediaPath`/`MediaUrl` 會重寫為類似 `media/inbound/<filename>` 的相對路徑。
- 媒體理解（若透過 `tools.media.*` 或共用 `tools.media.models` 設定）會在模板處理前執行，並可插入 `[Image]`、`[Audio]`、`[Video]` 區塊到 `Body`。
  - 音訊會設定 `{{Transcript}}` 並使用文字轉錄結果進行指令解析，確保斜線指令仍可運作。
  - 影片與圖片描述會保留任何說明文字以供指令解析。
- 預設只處理第一個符合條件的圖片/音訊/影片附件；可設定 `tools.media.<cap>.attachments` 以處理多個附件。

## 限制與錯誤

**外發限制（WhatsApp web 發送）**

- 圖片：重新壓縮後約 6 MB 上限。
- 音訊/語音/影片：16 MB 上限；文件：100 MB 上限。
- 超過大小或無法讀取的媒體 → 日誌中清楚顯示錯誤，且跳過回覆。

**媒體理解限制（轉錄/描述）**

- 影像預設大小：10 MB (`tools.media.image.maxBytes`)。
- 音訊預設大小：20 MB (`tools.media.audio.maxBytes`)。
- 影片預設大小：50 MB (`tools.media.video.maxBytes`)。
- 超過大小限制的媒體會跳過理解處理，但回覆仍會以原始內容送出。

## 測試注意事項

- 涵蓋影像／音訊／文件的傳送與回覆流程。
- 驗證影像的重新壓縮（大小限制）及音訊的語音備註標記。
- 確保多媒體回覆會依序分批送出。
