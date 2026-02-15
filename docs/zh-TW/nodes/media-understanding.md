---
summary: "傳入 圖片/音訊/影片 理解功能（選用），支援供應商與 CLI 備援"
read_when:
  - 設計或重構媒體理解功能時
  - 調整傳入音訊/影片/圖片預處理時
title: "媒體理解"
---

# 媒體理解 (傳入) — 2026-01-17

OpenClaw 可以在回覆流程執行前**摘要傳入的媒體** (圖片/音訊/影片)。它會自動偵測本機工具或供應商金鑰是否可用，且可以停用或自訂。如果停用理解功能，模型仍會照常收到原始檔案或 URL。

## 目標

- 選用：將傳入的媒體預先彙整為短文字，以實現更快的路由與更精確的指令解析。
- 始終保留原始媒體並傳送至模型。
- 支援 **供應商 API** 與 **CLI 備援**。
- 允許設定多個模型，並按順序進行備援 (依據錯誤/大小/逾時)。

## 高階行為

1. 收集傳入的附件 (`MediaPaths`, `MediaUrls`, `MediaTypes`)。
2. 針對每個啟用的功能 (圖片/音訊/影片)，根據原則選擇附件 (預設為：**第一個**)。
3. 選擇第一個符合條件的模型項目 (大小 + 功能 + 驗證)。
4. 如果模型失敗或媒體檔案太大，則**退回到下一個項目**。
5. 成功時：
   - `Body` 會變為 `[Image]`, `[Audio]` 或 `[Video]` 區塊。
   - 音訊會設定 `{{Transcript}}`；指令解析會優先使用說明文字（若存在），否則使用逐字稿。
   - 說明文字會保留在區塊內的 `User text:` 中。

如果理解失敗或被停用，**回覆流程會繼續執行**，並帶有原始內容與附件。

## 設定概覽

`tools.media` 支援 **共用模型** 以及針對個別功能的覆寫：

- `tools.media.models`: 共用模型清單 (使用 `capabilities` 進行篩選)。
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - 預設值 (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - 供應商覆寫 (`baseUrl`, `headers`, `providerOptions`)
  - 透過 `tools.media.audio.providerOptions.deepgram` 設定 Deepgram 音訊選項
  - 選用的 **個別功能 `models` 清單** (優先於共用模型)
  - `attachments` 原則 (`mode`, `maxAttachments`, `prefer`)
  - `scope` (選用，可依據頻道/聊天類型/工作階段鍵值進行篩選)
- `tools.media.concurrency`: 功能同時執行的最大數量 (預設為 **2**)。

```json5
{
  tools: {
    media: {
      models: [
        /* 共用清單 */
      ],
      image: {
        /* 選用覆寫 */
      },
      audio: {
        /* 選用覆寫 */
      },
      video: {
        /* 選用覆寫 */
      },
    },
  },
}
```

### 模型項目

每個 `models[]` 項目可以是 **供應商 (provider)** 或 **CLI**：

```json5
{
  type: "provider", // 若省略則預設為此項
  provider: "openai",
  model: "gpt-5.2",
  prompt: "請在 500 字內描述這張圖片。",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // 選用，用於多模態項目
  profile: "vision-profile",
  preferredProfile: "vision-fallback",
}
```

```json5
{
  type: "cli",
  command: "gemini",
  args: [
    "-m",
    "gemini-3-flash",
    "--allowed-tools",
    "read_file",
    "讀取位於 {{MediaPath}} 的媒體，並在 {{MaxChars}} 個字內描述它。",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
}
```

CLI 範本還可以使用：

- `{{MediaDir}}` (包含媒體檔案的目錄)
- `{{OutputDir}}` (為此次執行建立的暫存目錄)
- `{{OutputBase}}` (暫存檔案的基本路徑，不含副檔名)

## 預設值與限制

建議預設值：

- `maxChars`: 圖片/影片為 **500** (短小精悍，利於指令解析)
- `maxChars`: 音訊 **不設定** (除非您設定限制，否則會提供完整逐字稿)
- `maxBytes`:
  - 圖片: **10MB**
  - 音訊: **20MB**
  - 影片: **50MB**

規則：

- 如果媒體超過 `maxBytes`，將跳過該模型並**嘗試下一個模型**。
- 如果模型傳回的內容超過 `maxChars`，輸出的內容會被裁切。
- `prompt` 預設為簡單的 “Describe the {media}.” 加上 `maxChars` 指引 (僅限圖片/影片)。
- 如果 `<capability>.enabled: true` 但未設定任何模型，OpenClaw 會在**目前啟用的回覆模型**供應商支援該功能時嘗試使用它。

### 自動偵測媒體理解 (預設)

如果 `tools.media.<capability>.enabled` **未**設定為 `false` 且您尚未設定模型，OpenClaw 會依序自動偵測並**停止於第一個可用的選項**：

1. **本機 CLI** (僅限音訊；若已安裝)
   - `sherpa-onnx-offline` (需要 `SHERPA_ONNX_MODEL_DIR` 並包含 encoder/decoder/joiner/tokens)
   - `whisper-cli` (`whisper-cpp`；使用 `WHISPER_CPP_MODEL` 或內建的 tiny 模型)
   - `whisper` (Python CLI；自動下載模型)
2. **Gemini CLI** (`gemini`)，使用 `read_many_files`
3. **供應商金鑰**
   - 音訊：OpenAI → Groq → Deepgram → Google
   - 圖片：OpenAI → Anthropic → Google → MiniMax
   - 影片：Google

若要停用自動偵測，請設定：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: false,
      },
    },
  },
}
```

注意：執行檔偵測在 macOS/Linux/Windows 上皆為盡力而為；請確保 CLI 位於 `PATH` 中 (我們會展開 `~`)，或設定帶有完整路徑的明確 CLI 模型。

## 功能 (選用)

如果您設定了 `capabilities`，該項目僅會針對這些媒體類型執行。對於共用清單，OpenClaw 可以推斷預設值：

- `openai`, `anthropic`, `minimax`: **image** (圖片)
- `google` (Gemini API): **image + audio + video** (圖片 + 音訊 + 影片)
- `groq`: **audio** (音訊)
- `deepgram`: **audio** (音訊)

對於 CLI 項目，**請明確設定 `capabilities`** 以避免意外匹配。如果您省略 `capabilities`，該項目將適用於它所在的清單。

## 供應商支援矩陣 (OpenClaw 整合)

| 功能         | 供應商整合                                                  | 備註                                         |
| ------------ | ----------------------------------------------------------- | -------------------------------------------- |
| 圖片 (Image) | OpenAI / Anthropic / Google / 其他透過 `pi-ai` 整合的供應商 | 註冊表中任何具備圖片功能的模型皆可運作。     |
| 音訊 (Audio) | OpenAI, Groq, Deepgram, Google                              | 供應商逐字稿功能 (Whisper/Deepgram/Gemini)。 |
| 影片 (Video) | Google (Gemini API)                                         | 供應商影片理解功能。                         |

## 推薦供應商

**圖片**

- 如果您目前使用的模型支援圖片，請優先使用。
- 良好的預設值：`openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`。

**音訊**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo`, 或 `deepgram/nova-3`。
- CLI 備援：`whisper-cli` (whisper-cpp) 或 `whisper`。
- Deepgram 設定：[Deepgram (音訊逐字稿)](/providers/deepgram)。

**影片**

- `google/gemini-3-flash-preview` (快速), `google/gemini-3-pro-preview` (內容豐富)。
- CLI 備援：`gemini` CLI (支援影片/音訊的 `read_file`)。

## 附件原則

個別功能的 `attachments` 設定控制哪些附件會被處理：

- `mode`: `first` (預設) 或 `all`
- `maxAttachments`: 限制處理數量 (預設為 **1**)
- `prefer`: `first`, `last`, `path`, `url`

當 `mode: "all"` 時，輸出會被標記為 `[Image 1/2]`, `[Audio 2/2]` 等。

## 設定範例

### 1) 共用模型清單 + 覆寫

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },
        {
          provider: "google",
          model: "gemini-3-flash-preview",
          capabilities: ["image", "audio", "video"],
        },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "讀取位於 {{MediaPath}} 的媒體，並在 {{MaxChars}} 個字內描述它。",
          ],
          capabilities: ["image", "video"],
        },
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 },
      },
      video: {
        maxChars: 500,
      },
    },
  },
}
```

### 2) 僅啟用音訊 + 影片 (停用圖片)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
          },
        ],
      },
      video: {
        enabled: true,
        maxChars: 500,
        models: [
          { provider: "google", model: "gemini-3-flash-preview" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "讀取位於 {{MediaPath}} 的媒體，並在 {{MaxChars}} 個字內描述它。",
            ],
          },
        ],
      },
    },
  },
}
```

### 3) 選用的圖片理解功能

```json5
{
  tools: {
    media: {
      image: {
        enabled: true,
        maxBytes: 10485760,
        maxChars: 500,
        models: [
          { provider: "openai", model: "gpt-5.2" },
          { provider: "anthropic", model: "claude-opus-4-6" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "讀取位於 {{MediaPath}} 的媒體，並在 {{MaxChars}} 個字內描述它。",
            ],
          },
        ],
      },
    },
  },
}
```

### 4) 多模態單一項目 (明確指定功能)

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## 狀態輸出

當媒體理解功能執行時，`/status` 會包含一行簡短的摘要：

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

這會顯示每個功能的執行結果，以及所選用的供應商/模型。

## 注意事項

- 理解功能採用**盡力而為**原則。錯誤不會阻止回覆。
- 即使停用理解功能，附件仍會傳送至模型。
- 使用 `scope` 來限制理解功能執行的範圍 (例如：僅限私訊)。

## 相關文件

- [設定](/gateway/configuration)
- [圖片與媒體支援](/nodes/images)
