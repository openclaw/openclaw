---
summary: "入站音訊/語音備忘錄如何下載、轉錄並注入回覆"
read_when:
  - 變更音訊轉錄或媒體處理方式
title: "音訊與語音備忘錄"
---

# 音訊 / 語音備忘錄 — 2026-01-17

## 運作方式

- **媒體理解（音訊）**：如果啟用音訊理解（或自動偵測），OpenClaw 將：
  1. 定位第一個音訊附件（本地路徑或 URL），並在需要時下載。
  2. 在傳送至每個模型項目之前，強制執行 `maxBytes`。
  3. 依序執行第一個符合條件的模型項目（供應商或 CLI）。
  4. 如果失敗或跳過（大小/逾時），則嘗試下一個項目。
  5. 成功後，將 `Body` 替換為 `[Audio]` 區塊並設定 `{{Transcript}}`。
- **指令解析**：轉錄成功後，`CommandBody`/`RawBody` 會設定為轉錄文本，以便斜線指令仍然有效。
- **詳細日誌記錄**：在 `--verbose` 模式下，我們會記錄轉錄執行的時間以及替換 Body 的時間。

## 自動偵測（預設）

如果您**未設定模型**且 `tools.media.audio.enabled` **未**設為 `false`，
OpenClaw 會依此順序自動偵測並在第一個可用的選項處停止：

1. **本地 CLI**（如果已安裝）
   - `sherpa-onnx-offline`（需要包含 encoder/decoder/joiner/tokens 的 `SHERPA_ONNX_MODEL_DIR`）
   - `whisper-cli`（來自 `whisper-cpp`；使用 `WHISPER_CPP_MODEL` 或捆綁的 tiny 模型）
   - `whisper` (Python CLI；自動下載模型)
2. **Gemini CLI** (`gemini`) 使用 `read_many_files`
3. **供應商金鑰** (OpenAI → Groq → Deepgram → Google)

要停用自動偵測，請設定 `tools.media.audio.enabled: false`。
要自訂，請設定 `tools.media.audio.models`。
注意：二進制檔案偵測在 macOS/Linux/Windows 上盡力而為；請確保 CLI 位於 `PATH`（我們會展開 `~`），或者使用完整指令路徑設定明確的 CLI 模型。

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

### 僅供應商（帶範圍控制）

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

- 供應商憑證遵循標準模型憑證順序（憑證設定檔、環境變數、`models.providers.*.apiKey`）。
- 當使用 `provider: "deepgram"` 時，Deepgram 會取得 `DEEPGRAM_API_KEY`。
- Deepgram 設定詳情：[Deepgram (音訊轉錄)](/providers/deepgram)。
- 音訊供應商可以透過 `tools.media.audio` 覆寫 `baseUrl`、`headers` 和 `providerOptions`。
- 預設大小上限為 20MB (`tools.media.audio.maxBytes`)。超出大小的音訊將被該模型跳過，並嘗試下一個項目。
- 音訊的預設 `maxChars` 為**未設定**（完整轉錄文本）。設定 `tools.media.audio.maxChars` 或每個項目的 `maxChars` 以修剪輸出。
- OpenAI 自動預設為 `gpt-4o-mini-transcribe`；設定 `model: "gpt-4o-transcribe"` 以獲得更高的準確度。
- 使用 `tools.media.audio.attachments` 處理多個語音備忘錄（`mode: "all"` + `maxAttachments`）。
- 轉錄文本可作為 `{{Transcript}}` 供模板使用。
- CLI stdout 有上限（5MB）；請保持 CLI 輸出簡潔。

## 群組中的提及偵測

當群組聊天設定 `requireMention: true` 時，OpenClaw 現在會在檢查提及**之前**轉錄音訊。這允許即使語音備忘錄包含提及也能被處理。

**運作方式：**

1. 如果語音訊息沒有文字內容且群組需要提及，OpenClaw 會執行「預檢」轉錄。
2. 轉錄文本會被檢查提及模式（例如，` @BotName`、表情符號觸發器）。
3. 如果發現提及，訊息將透過完整的回覆流程處理。
4. 轉錄文本用於提及偵測，因此語音備忘錄可以通過提及檢查。

**備援行為：**

- 如果轉錄在預檢期間失敗（逾時、API 錯誤等），則訊息將根據僅文字提及偵測進行處理。
- 這確保了混合訊息（文字 + 音訊）永遠不會被錯誤地丟棄。

**範例：** 用戶在設定了 `requireMention: true` 的 Telegram 群組中發送語音備忘錄說：「嘿 @trip-bangkok/CLAUDE.md，天氣怎麼樣？」語音備忘錄被轉錄，提及被偵測到，並且智慧代理回覆。

## 注意事項

- 範圍規則採用第一個符合者獲勝。`chatType` 被正規化為 `direct`、`group` 或 `room`。
- 確保您的 CLI 以 0 結束並列印純文字；JSON 需要透過 `jq -r .text` 進行處理。
- 保持逾時時間合理（`timeoutSeconds`，預設 60 秒）以避免阻塞回覆佇列。
- 預檢轉錄僅處理**第一個**音訊附件用於提及偵測。額外的音訊將在主要媒體理解階段處理。
