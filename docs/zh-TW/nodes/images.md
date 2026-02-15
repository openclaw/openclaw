---
summary: "傳送、Gateway 及智慧代理回覆的圖片與多媒體處理規則"
read_when:
  - 修改多媒體管線或附件時
title: "圖片與多媒體支援"
---

# 圖片與多媒體支援 — 2025-12-05

WhatsApp 頻道透過 Baileys Web 運行。本文件記錄了目前傳送、Gateway 及智慧代理回覆的多媒體處理規則。

## 目標

- 透過 `openclaw message send --media` 傳送帶有選用說明（caption）的多媒體。
- 允許網頁收件匣的自動回覆在文字之外包含多媒體。
- 保持各類型的限制合理且可預測。

## CLI 介面

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` 為選填；僅傳送多媒體時，說明（caption）可以為空。
  - `--dry-run` 會列印解析後的負載（payload）；`--json` 則輸出 `{ channel, to, messageId, mediaUrl, caption }`。

## WhatsApp Web 頻道行為

- 輸入：本地檔案路徑**或** HTTP(S) URL。
- 流程：載入至 Buffer，偵測多媒體種類，並建構正確的負載：
  - **圖片：** 調整大小並重新壓縮為 JPEG（長邊最大 2048px），目標大小參考 `agents.defaults.mediaMaxMb`（預設 5 MB），上限為 6 MB。
  - **音訊/語音/影片：** 直接傳送，上限 16 MB；音訊會以語音訊息（voice note，`ptt: true`）形式傳送。
  - **文件：** 其他任何類型，上限 100 MB，若可行則保留檔名。
- WhatsApp GIF 風格播放：傳送帶有 `gifPlayback: true` 的 MP4（CLI：`--gif-playback`），讓行動裝置用戶端能直接循環播放。
- MIME 偵測優先順序：magic bytes、標頭（headers）、副檔名。
- 說明文字來自 `--message` 或 `reply.text`；允許空說明。
- 日誌：非詳細模式顯示 `↩️`/`✅`；詳細模式包含大小及來源路徑/URL。

## 自動回覆管線

- `getReplyFromConfig` 回傳 `{ text?, mediaUrl?, mediaUrls? }`。
- 當存在多媒體時，網頁傳送器會使用與 `openclaw message send` 相同的管線來解析本地路徑或 URL。
- 若提供多個多媒體項目，將依序傳送。

## 傳入多媒體至指令 (Pi)

- 當傳入的網頁訊息包含多媒體時，OpenClaw 會將其下載至暫存檔，並提供模板變數：
  - `{{MediaUrl}}`：傳入多媒體的虛擬 URL。
  - `{{MediaPath}}`：執行指令前寫入的本地暫存路徑。
- 當啟用了個別工作階段的 Docker 沙箱時，傳入的多媒體會被複製到沙箱工作區中，且 `MediaPath`/`MediaUrl` 會被重寫為相對路徑，例如 `media/inbound/<filename>`。
- 多媒體理解（若透過 `tools.media.*` 或共享的 `tools.media.models` 設定）會在模板處理前運行，並可在 `Body` 中插入 `[Image]`、`[Audio]` 與 `[Video]` 區塊。
  - 音訊會設定 `{{Transcript}}` 並使用逐字稿進行指令解析，因此斜線指令（slash commands）仍可運作。
  - 影片與圖片描述會保留任何說明文字以供指令解析。
- 預設僅處理第一個符合的圖片/音訊/影片附件；設定 `tools.media.<cap>.attachments` 以處理多個附件。

## 限制與錯誤

**傳出傳送上限（WhatsApp 網頁傳送）**

- 圖片：重新壓縮後上限約 6 MB。
- 音訊/語音/影片：上限 16 MB；文件：上限 100 MB。
- 超過大小或無法讀取的多媒體 → 在日誌中顯示明確錯誤並跳過該回覆。

**多媒體理解上限（逐字稿/描述）**

- 圖片預設：10 MB (`tools.media.image.maxBytes`)。
- 音訊預設：20 MB (`tools.media.audio.maxBytes`)。
- 影片預設：50 MB (`tools.media.video.maxBytes`)。
- 超過大小的多媒體將跳過理解步驟，但回覆仍會以原始內容送出。

## 測試注意事項

- 涵蓋圖片/音訊/文件案例的傳送與回覆流程。
- 驗證圖片的重新壓縮（大小限制）以及音訊的語音訊息標籤。
- 確保多個多媒體回覆會以序列傳送的方式展開。
