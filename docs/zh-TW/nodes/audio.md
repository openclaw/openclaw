---
summary: >-
  How inbound audio/voice notes are downloaded, transcribed, and injected into
  replies
read_when:
  - Changing audio transcription or media handling
title: Audio and Voice Notes
---

# 音訊 / 語音筆記 — 2026-01-17

## 可用功能

- **媒體理解（音訊）**：如果啟用音訊理解（或自動偵測），OpenClaw 將會：
  1. 定位第一個音訊附件（本地路徑或 URL），並在需要時下載。
  2. 在送出給每個模型條目前，強制執行 `maxBytes`。
  3. 依序執行第一個符合條件的模型條目（供應商或 CLI）。
  4. 若失敗或跳過（大小/逾時），則嘗試下一個條目。
  5. 成功時，將 `Body` 替換為 `[Audio]` 區塊，並設定 `{{Transcript}}`。
- **指令解析**：當轉錄成功時，`CommandBody`/`RawBody` 會被設定為轉錄文字，確保斜線指令仍可使用。
- **詳細日誌**：在 `--verbose` 中，我們會記錄轉錄執行時間及何時替換內容。

## 自動偵測（預設）

如果你**未設定模型**且 `tools.media.audio.enabled` **未設定為** `false`，
OpenClaw 將依照以下順序自動偵測，並在第一個可用選項停止：

1. **本地 CLI**（若已安裝）
   - `sherpa-onnx-offline`（需要 `SHERPA_ONNX_MODEL_DIR`，包含編碼器/解碼器/連接器/token）
   - `whisper-cli`（來自 `whisper-cpp`；使用 `WHISPER_CPP_MODEL` 或內建的 tiny 模型）
   - `whisper`（Python CLI；自動下載模型）
2. **Gemini CLI**（`gemini`）使用 `read_many_files`
3. **供應商金鑰**（OpenAI → Groq → Deepgram → Google）

若要停用自動偵測，請設定 `tools.media.audio.enabled: false`。
若要自訂，請設定 `tools.media.audio.models`。
注意：二進位檔偵測在 macOS/Linux/Windows 上為盡力而為；請確保 CLI 在 `PATH`（我們會展開 `~`），或使用完整指令路徑設定明確的 CLI 模型。

## 設定範例

### 供應商 + CLI 備援（OpenAI + Whisper CLI）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### 僅供應商並限制範圍

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### 僅供應商（Deepgram）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

### 僅供應商（Mistral Voxtral）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

### 回音文字稿回傳聊天（選擇加入）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        echoTranscript: true, // default is false
        echoFormat: '📝 "{transcript}"', // optional, supports {transcript}
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

## 注意事項與限制

- 供應商認證遵循標準模型認證順序（認證設定檔、環境變數、`models.providers.*.apiKey`）。
- 使用 `provider: "deepgram"` 時，Deepgram 會自動採用 `DEEPGRAM_API_KEY`。
- Deepgram 設定詳情請參考：[Deepgram（語音轉錄）](/providers/deepgram)。
- Mistral 設定詳情請參考：[Mistral](/providers/mistral)。
- 音訊供應商可透過 `tools.media.audio` 覆寫 `baseUrl`、`headers` 及 `providerOptions`。
- 預設大小上限為 20MB（`tools.media.audio.maxBytes`）。超過大小的音訊會跳過該模型，並嘗試下一筆。
- 小於 1024 位元組的極小或空白音訊檔會在供應商/CLI 轉錄前被跳過。
- 音訊的預設 `maxChars` 為 **未設定**（完整文字稿）。可設定 `tools.media.audio.maxChars` 或每筆 `maxChars` 以裁剪輸出。
- OpenAI 預設自動為 `gpt-4o-mini-transcribe`；可設定 `model: "gpt-4o-transcribe"` 以提高準確度。
- 使用 `tools.media.audio.attachments` 可處理多段語音備忘錄（`mode: "all"` + `maxAttachments`）。
- 文字稿可透過 `{{Transcript}}` 提供給模板使用。
- `tools.media.audio.echoTranscript` 預設關閉；啟用後會在代理處理前將文字稿確認回傳至原始聊天。
- `tools.media.audio.echoFormat` 可自訂回音文字（佔位符：`{transcript}`）。
- CLI 標準輸出限制為 5MB；請保持 CLI 輸出簡潔。

### 代理環境支援

基於供應商的語音轉錄會遵守標準的外發代理環境變數：

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `https_proxy`
- `http_proxy`

若未設定代理環境變數，則使用直接外發。若代理設定格式錯誤，OpenClaw 會記錄警告並回退為直接擷取。

## 群組中的提及偵測

當群組聊天設定了 `requireMention: true`，OpenClaw 現在會在檢查提及前先轉錄語音。這讓語音備忘錄即使包含提及也能被處理。

**運作方式：**

1. 若語音訊息無文字內容且群組需要提及，OpenClaw 會先進行「預先」轉錄。
2. 文字稿會檢查提及模式（例如 `@BotName`、表情符號觸發）。
3. 若偵測到提及，訊息會進入完整回覆流程。
4. 文字稿用於提及偵測，讓語音備忘錄能通過提及門檻。

**備援行為：**

- 若預先轉錄失敗（逾時、API 錯誤等），訊息會依文字提及偵測進行處理。
- 確保混合訊息（文字＋語音）不會被錯誤丟棄。

**每個 Telegram 群組/主題的選擇退出設定：**

- 設定 `channels.telegram.groups.<chatId>.disableAudioPreflight: true` 以跳過該群組的預檢轉錄提及檢查。
- 設定 `channels.telegram.groups.<chatId>.topics.<threadId>.disableAudioPreflight` 以覆寫每個主題的設定（`true` 為跳過，`false` 為強制啟用）。
- 預設為 `false`（當符合提及門檻條件時啟用預檢）。

**範例：** 使用者在帶有 `requireMention: true` 的 Telegram 群組中傳送語音訊息說「嘿 @Claude，天氣如何？」語音訊息被轉錄，偵測到提及，代理人回覆。

## 注意事項

- 範圍規則採用首個匹配優先。`chatType` 會被正規化為 `direct`、`group` 或 `room`。
- 確保你的 CLI 以 0 結束並輸出純文字；JSON 需透過 `jq -r .text` 進行處理。
- 對於 `parakeet-mlx`，如果你傳入 `--output-dir`，當 `--output-format` 為 `txt`（或省略）時，OpenClaw 會讀取 `<output-dir>/<media-basename>.txt`；非 `txt` 的輸出格式則回退至標準輸出解析。
- 保持逾時時間合理（`timeoutSeconds`，預設 60 秒）以避免阻塞回覆佇列。
- 預檢轉錄僅處理**第一個**音訊附件以偵測提及。其他音訊會在主要媒體理解階段處理。
