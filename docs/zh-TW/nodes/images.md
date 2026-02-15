---
summary: "用於傳送、Gateway 和智慧代理回覆的圖片和媒體處理規則"
read_when:
  - 修改媒體管道或附件
title: "圖片和媒體支援"
---

# 圖片和媒體支援 — 2025-12-05

WhatsApp 頻道透過 **Baileys Web** 執行。本文件說明了用於傳送、Gateway 和智慧代理回覆的當前媒體處理規則。

## 目標

- 透過 `openclaw message send --media` 傳送帶有可選圖片說明的媒體。
- 允許來自網路收件匣的自動回覆包含文字和媒體。
- 保持各類型限制合理且可預測。

## CLI 介面

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` 為可選；圖片說明可以為空，僅用於傳送媒體。
  - `--dry-run` 列印解析後的負載；`--json` 輸出 `{ channel, to, messageId, mediaUrl, caption }`。

## WhatsApp Web 頻道行為

- 輸入：本地檔案路徑 **或** HTTP(S) URL。
- 流程：載入到 Buffer，檢測媒體類型，並建立正確的負載：
  - **圖片：** 調整大小並重新壓縮為 JPEG (最大邊長 2048px)，目標為 `agents.defaults.mediaMaxMb` (預設 5 MB)，上限為 6 MB。
  - **音訊/語音/影片：** 直通傳輸，上限 16 MB；音訊作為語音備忘錄傳送 (`ptt: true`)。
  - **文件：** 其他任何檔案，上限 100 MB，並保留檔案名稱（如果可用）。
- WhatsApp GIF 樣式播放：傳送帶有 `gifPlayback: true` (CLI: `--gif-playback`) 的 MP4，以便行動用戶端在內聯中循環播放。
- MIME 檢測優先使用魔術位元，然後是標頭，最後是檔案副檔名。
- 圖片說明來自 `--message` 或 `reply.text`；允許空圖片說明。
- 記錄：非詳細模式顯示 `↩️`/`✅`；詳細模式包括大小和來源路徑/URL。

## 自動回覆管道

- `getReplyFromConfig` 返回 `{ text?, mediaUrl?, mediaUrls? }`。
- 當媒體存在時，網路寄件者使用與 `openclaw message send` 相同的管道解析本地路徑或 URL。
- 如果提供多個媒體項目，將按順序傳送。

## 入站媒體到命令 (Pi)

- 當入站網路訊息包含媒體時，OpenClaw 會下載到臨時檔案並公開範本變數：
  - `{{MediaUrl}}` 入站媒體的偽 URL。
  - `{{MediaPath}}` 執行命令前寫入的本地臨時路徑。
- 當啟用每個工作階段的 Docker 沙箱隔離時，入站媒體會複製到沙箱工作區，`MediaPath`/`MediaUrl` 會重寫為相對路徑，例如 `media/inbound/<filename>`。
- 媒體理解（如果透過 `tools.media.*` 或共享 `tools.media.models` 設定）在範本化之前執行，並可以將 `[Image]`、`[Audio]` 和 `[Video]` 區塊插入 `Body`。
  - 音訊設定 `{{Transcript}}` 並使用逐字稿進行命令解析，以便斜線命令仍然有效。
  - 影片和圖片描述保留任何圖片說明文字，用於命令解析。
- 預設情況下，僅處理第一個匹配的圖片/音訊/影片附件；設定 `tools.media.<cap>.attachments` 以處理多個附件。

## 限制與錯誤

**出站傳送上限 (WhatsApp 網路傳送)**

- 圖片：重新壓縮後約 6 MB 上限。
- 音訊/語音/影片：16 MB 上限；文件：100 MB 上限。
- 超大或無法讀取的媒體 → 記錄中顯示明確錯誤，並跳過回覆。

**媒體理解上限 (轉錄/描述)**

- 圖片預設：10 MB (`tools.media.image.maxBytes`)。
- 音訊預設：20 MB (`tools.media.audio.maxBytes`)。
- 影片預設：50 MB (`tools.media.video.maxBytes`)。
- 超大媒體會跳過理解，但回覆仍會以原始內容傳送。

## 測試注意事項

- 涵蓋圖片/音訊/文件案例的傳送 + 回覆流程。
- 驗證圖片的重新壓縮（大小限制）和音訊的語音備忘錄標誌。
- 確保多媒體回覆可以扇出為連續傳送。
