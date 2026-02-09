---
summary: "send、gateway 與 agent 回覆的影像與媒體處理規則"
read_when:
  - 修改媒體管線或附件
title: "圖片與媒體支援"
---

# 圖片與媒體支援 — 2025-12-05

WhatsApp 頻道透過 **Baileys Web** 運作。本文件說明目前用於傳送、Gateway 閘道器 與代理程式回覆的媒體處理規則。 本文件記錄了 send、gateway 與 agent 回覆目前的媒體處理規則。

## 目標

- 透過 `openclaw message send --media` 傳送媒體，並可選擇性附加說明文字。
- 允許來自網頁收件匣的自動回覆在文字之外包含媒體。
- Keep per-type limits sane and predictable.

## CLI 介面

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` 為選用；純媒體傳送時說明文字可為空。
  - `--dry-run` 會列印解析後的 payload；`--json` 會輸出 `{ channel, to, messageId, mediaUrl, caption }`。

## WhatsApp Web 頻道行為

- 輸入：本機檔案路徑 **或** HTTP(S) URL。
- 流程：載入為 Buffer、偵測媒體類型，並建立正確的 payload：
  - **圖片：** 重新調整大小並重新壓縮為 JPEG（最長邊 2048px），目標為 `agents.defaults.mediaMaxMb`（預設 5 MB），上限 6 MB。
  - **音訊／語音／影片：** 直接傳送，最多 16 MB；音訊會以語音備忘錄形式傳送（`ptt: true`）。
  - **文件：** 其他任何類型，最多 100 MB，若可取得則保留檔名。
- WhatsApp GIF 風格播放：傳送帶有 `gifPlayback: true` 的 MP4（CLI：`--gif-playback`），讓行動裝置客戶端可內嵌循環播放。
- MIME 偵測優先順序為 magic bytes，其次為標頭，最後為副檔名。
- 說明文字來源為 `--message` 或 `reply.text`；允許空白說明文字。
- 記錄：非詳細模式顯示 `↩️`/`✅`；詳細模式包含大小與來源路徑/URL。

## 自動回覆管線

- `getReplyFromConfig` 會回傳 `{ text?, mediaUrl?, mediaUrls? }`。
- 當包含媒體時，網頁傳送端會使用與 `openclaw message send` 相同的管線來解析本機路徑或 URL。
- 若提供多個媒體項目，將依序逐一傳送。

## 指令的入站媒體（Pi）

- 當傳入的 Web 訊息包含媒體時，OpenClaw 會下載到暫存檔並提供樣板變數：
  - `{{MediaUrl}}`：指向入站媒體的偽 URL。
  - `{{MediaPath}}`：在執行指令前寫入的本機暫存路徑。
- 當啟用每個工作階段的 Docker 沙箱時，入站媒體會被複製到沙箱工作區，且 `MediaPath`/`MediaUrl` 會被重寫為類似 `media/inbound/<filename>` 的相對路徑。
- 媒體理解（若透過 `tools.media.*` 或共用的 `tools.media.models` 設定）會在樣板處理前執行，並可將 `[Image]`、`[Audio]` 與 `[Video]` 區塊插入到 `Body` 中。
  - 音訊會設定 `{{Transcript}}`，並使用逐字稿進行指令解析，以確保斜線指令仍可運作。
  - 影片與圖片描述會保留任何說明文字以供指令解析。
- 預設僅處理第一個符合的圖片／音訊／影片附件；設定 `tools.media.<cap>.attachments` 以處理多個附件。

## 限制與錯誤

**外送傳送上限（WhatsApp Web 傳送）**

- 圖片：重新壓縮後約 6 MB 上限。
- 音訊／語音／影片：16 MB 上限；文件：100 MB 上限。
- 超出大小或無法讀取的媒體 → 記錄中顯示清楚錯誤，且該回覆會被略過。

**媒體理解上限（轉錄／描述）**

- 圖片預設：10 MB（`tools.media.image.maxBytes`）。
- 音訊預設：20 MB（`tools.media.audio.maxBytes`）。
- 影片預設：50 MB（`tools.media.video.maxBytes`）。
- Oversize media skips understanding, but replies still go through with the original body.

## 測試注意事項

- Cover send + reply flows for image/audio/document cases.
- 驗證圖片重新壓縮（大小限制）與音訊的語音備忘錄旗標。
- 確保多媒體回覆會以序列方式分批傳送。
