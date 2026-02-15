---
summary: "說明如何下載傳入的音訊/語音訊息、進行逐字稿轉錄，並將其併入回覆中"
read_when:
  - 更改音訊逐字稿轉錄或媒體處理方式時
title: "音訊與語音訊息"
---

# 音訊 / 語音訊息 — 2026-01-17

## 功能說明

- **媒體理解 (音訊)**：如果啟用了音訊理解功能（或自動偵測到），OpenClaw 會：
  1. 定位第一個音訊附件（本機路徑或 URL），並在需要時下載。
  2. 在傳送到各個模型項目之前，強制執行 `maxBytes` 限制。
  3. 依序執行第一個符合條件的模型項目（供應商或 CLI）。
  4. 如果失敗或略過（因大小/逾時），則嘗試下一個項目。
  5. 成功後，它會將 `Body` 替換為 `[Audio]` 區塊，並設定 `{{Transcript}}`。
- **指令解析**：當逐字稿轉錄成功時，`CommandBody`/`RawBody` 會被設定為逐字稿內容，因此斜線指令（slash commands）仍可正常運作。
- **詳細記錄 (Verbose logging)**：在 `--verbose` 模式下，我們會記錄逐字稿轉錄執行的時間點以及何時替換本文（body）。

## 自動偵測 (預設)

如果您**未設定模型**，且 `tools.media.audio.enabled` 未設為 `false`，OpenClaw 會依以下順序自動偵測，並在找到第一個可用的選項時停止：

1. **本機 CLI** (如果已安裝)
   - `sherpa-onnx-offline` (需提供 `SHERPA_ONNX_MODEL_DIR`，包含 encoder/decoder/joiner/tokens)
   - `whisper-cli` (來自 `whisper-cpp`；使用 `WHISPER_CPP_MODEL` 或內建的 tiny 模型)
   - `whisper` (Python CLI；自動下載模型)
2. **Gemini CLI** (`gemini`) 使用 `read_many_files`
3. **供應商金鑰** (OpenAI → Groq → Deepgram → Google)

若要停用自動偵測，請設定 `tools.media.audio.enabled: false`。
若要自訂，請設定 `tools.media.audio.models`。
注意：二進制檔偵測在 macOS/Linux/Windows 上採盡力而為模式；請確保 CLI 已加入 `PATH`（我們會展開 `~`），或使用完整路徑設定明確的 CLI 模型。

## 設定範例

### 供應商 + CLI 備援 (OpenAI + Whisper CLI)

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

### 僅供應商（含範圍篩選）

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

### 僅供應商 (Deepgram)

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

## 注意事項與限制

- 供應商驗證遵循標準模型驗證順序（驗證設定檔、環境變數、`models.providers.*.apiKey`）。
- 當使用 `provider: "deepgram"` 時，Deepgram 會讀取 `DEEPGRAM_API_KEY`。
- Deepgram 設定詳情：[Deepgram (音訊逐字稿轉錄)](/providers/deepgram)。
- 音訊供應商可透過 `tools.media.audio` 覆蓋 `baseUrl`、`headers` 和 `providerOptions`。
- 預設大小上限為 20MB (`tools.media.audio.maxBytes`)。超過大小的音訊會被該模型略過，並嘗試下一個項目。
- 音訊的 `maxChars` 預設為**未設定**（完整逐字稿）。可設定 `tools.media.audio.maxChars` 或針對各個項目設定 `maxChars` 以裁切輸出內容。
- OpenAI 自動預設為 `gpt-4o-mini-transcribe`；若需更高準確度，請設定 `model: "gpt-4o-transcribe"`。
- 使用 `tools.media.audio.attachments` 處理多個語音訊息（`mode: "all"` + `maxAttachments`）。
- 逐字稿可在模板中以 `{{Transcript}}` 取得。
- CLI stdout 上限為 5MB；請保持 CLI 輸出簡潔。

## 群組中的提及（Mention）偵測

當群組聊天設定 `requireMention: true` 時，OpenClaw 現在會在檢查提及之前先轉錄音訊。這讓包含提及內容的語音訊息也能被處理。

**運作方式：**

1. 如果語音訊息沒有文字本文且群組要求提及，OpenClaw 會執行「預檢（preflight）」逐字稿轉錄。
2. 檢查逐字稿中是否包含提及模式（例如 `@智慧代理名稱`、表情符號觸發器）。
3. 如果找到提及，訊息將進入完整的回覆流程。
4. 逐字稿用於提及偵測，使語音訊息能通過提及門檻。

**備援行為：**

- 如果預檢期間逐字稿轉錄失敗（逾時、API 錯誤等），訊息將根據僅限文字的提及偵測進行處理。
- 這能確保混合訊息（文字 + 音訊）不會被錯誤地丟棄。

**範例：**使用者在設定了 `requireMention: true` 的 Telegram 群組中發送語音訊息說「嘿 @Claude，天氣如何？」。語音訊息被轉錄，偵測到提及，隨後智慧代理進行回覆。

## 注意事項

- 範圍規則（Scope rules）採用優先匹配原則。`chatType` 已標準化為 `direct`、`group` 或 `room`。
- 確保您的 CLI 以狀態碼 0 退出並列印純文字；JSON 格式需透過 `jq -r .text` 進行處理。
- 保持合理的逾時設定（`timeoutSeconds`，預設為 60 秒），避免阻塞回覆佇列。
- 預檢逐字稿轉錄僅處理**第一個**音訊附件以進行提及偵測。其他音訊將在主要的媒體理解階段處理。
