---
summary: "說明入站音訊／語音備忘錄如何被下載、轉寫，並注入回覆內容"
read_when:
  - 變更音訊轉寫或媒體處理時
title: "音訊與語音備忘錄"
x-i18n:
  source_path: nodes/audio.md
  source_hash: b926c47989ab0d1e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:34Z
---

# 音訊／語音備忘錄 — 2026-01-17

## 可用功能

- **媒體理解（音訊）**：若已啟用（或自動偵測）音訊理解，OpenClaw 會：
  1. 找出第一個音訊附件（本機路徑或 URL），必要時下載。
  2. 在送交每個模型項目前強制執行 `maxBytes`。
  3. 依序執行第一個符合資格的模型項目（提供者或 CLI）。
  4. 若失敗或略過（大小／逾時），則嘗試下一個項目。
  5. 成功時，將 `Body` 取代為 `[Audio]` 區塊，並設定 `{{Transcript}}`。
- **指令解析**：當轉寫成功時，會將 `CommandBody`／`RawBody` 設為轉寫內容，讓斜線指令仍可運作。
- **詳細記錄**：在 `--verbose` 中，會記錄轉寫執行時間以及取代本文的時機。

## 自動偵測（預設）

如果你**未設定模型**，且 `tools.media.audio.enabled` **未** 設為 `false`，
OpenClaw 會依下列順序自動偵測，並在第一個可用選項處停止：

1. **本機 CLI**（若已安裝）
   - `sherpa-onnx-offline`（需要 `SHERPA_ONNX_MODEL_DIR`，含 encoder／decoder／joiner／tokens）
   - `whisper-cli`（來自 `whisper-cpp`；使用 `WHISPER_CPP_MODEL` 或隨附的 tiny 模型）
   - `whisper`（Python CLI；會自動下載模型）
2. **Gemini CLI**（`gemini`），使用 `read_many_files`
3. **提供者金鑰**（OpenAI → Groq → Deepgram → Google）

若要停用自動偵測，請設定 `tools.media.audio.enabled: false`。
若要自訂，請設定 `tools.media.audio.models`。
注意：在 macOS／Linux／Windows 上，二進位檔偵測為盡力而為；請確保 CLI 位於 `PATH`（我們會展開 `~`），或使用完整指令路徑設定明確的 CLI 模型。

## 設定範例

### 提供者 + CLI 備援（OpenAI + Whisper CLI）

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

### 僅提供者，含範圍管控

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

### 僅提供者（Deepgram）

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

- 提供者身分驗證遵循標準模型驗證順序（驗證設定檔、環境變數、`models.providers.*.apiKey`）。
- 使用 `provider: "deepgram"` 時，Deepgram 會讀取 `DEEPGRAM_API_KEY`。
- Deepgram 設定細節：[Deepgram（音訊轉寫）](/providers/deepgram)。
- 音訊提供者可透過 `tools.media.audio` 覆寫 `baseUrl`、`headers` 與 `providerOptions`。
- 預設大小上限為 20MB（`tools.media.audio.maxBytes`）。超過上限的音訊會被該模型略過，並嘗試下一個項目。
- 音訊的預設 `maxChars` 為 **未設定**（完整轉寫）。請設定 `tools.media.audio.maxChars` 或每個項目的 `maxChars` 以裁剪輸出。
- OpenAI 的自動預設為 `gpt-4o-mini-transcribe`；設定 `model: "gpt-4o-transcribe"` 可提升準確度。
- 使用 `tools.media.audio.attachments` 以處理多個語音備忘錄（`mode: "all"` + `maxAttachments`）。
- 轉寫內容可於樣板中以 `{{Transcript}}` 取用。
- CLI stdout 具上限（5MB）；請保持 CLI 輸出精簡。

## 常見陷阱

- 範圍規則採用「第一個符合者優先」。`chatType` 會正規化為 `direct`、`group` 或 `room`。
- 請確保你的 CLI 以 0 結束並輸出純文字；若為 JSON，需透過 `jq -r .text` 進行處理。
- 請將逾時設定保持在合理範圍（`timeoutSeconds`，預設 60 秒），以避免阻塞回覆佇列。
