---
summary: "入站影像／音訊／影片理解（可選），支援提供者 + CLI 後備方案"
read_when:
  - 設計或重構媒體理解
  - 調校入站音訊／影片／影像的前處理
title: "媒體理解"
---

# 媒體理解（入站）— 2026-01-17

OpenClaw 可以在回覆流程執行前**彙整傳入媒體**（圖片/音訊/影片）。 It auto‑detects when local tools or provider keys are available, and can be disabled or customized. If understanding is off, models still receive the original files/URLs as usual.

## 目標

- 選用：將傳入媒體預先摘要成短文字，以加快路由並提升指令解析。
- 保留原始媒體傳遞給模型（始終如此）。
- 支援 **提供者 API** 與 **CLI 後備方案**。
- 允許多個模型並依序回退（錯誤/大小/逾時）。

## 高階行為

1. 收集入站附件（`MediaPaths`、`MediaUrls`、`MediaTypes`）。
2. 對於每個已啟用的能力（圖片/音訊/影片），依政策選擇附件（預設：**第一個**）。
3. 選擇第一個符合條件的模型項目（大小 + 能力 + 驗證）。
4. 若模型失敗或媒體過大，**後備至下一個項目**。
5. 成功時：
   - `Body` 會變成 `[Image]`、`[Audio]` 或 `[Video]` 區塊。
   - 音訊會設定 `{{Transcript}}`；指令解析在有字幕時使用字幕文字，否則使用逐字稿。
   - 字幕會以 `User text:` 的形式保留在區塊內。

若理解失敗或被停用，**回覆流程仍會繼續**，並使用原始內文 + 附件。

## 設定概覽

`tools.media` 支援 **共用模型** 以及各能力的覆寫設定：

- `tools.media.models`：共用模型清單（使用 `capabilities` 進行門控）。
- `tools.media.image` / `tools.media.audio` / `tools.media.video`：
  - 預設值（`prompt`、`maxChars`、`maxBytes`、`timeoutSeconds`、`language`）
  - 提供者覆寫（`baseUrl`、`headers`、`providerOptions`）
  - 透過 `tools.media.audio.providerOptions.deepgram` 的 Deepgram 音訊選項
  - 可選的 **各能力 `models` 清單**（優先於共用模型）
  - `attachments` 政策（`mode`、`maxAttachments`、`prefer`）
  - `scope`（可選，依頻道／聊天類型／工作階段金鑰進行門控）
- `tools.media.concurrency`：能力同時執行的最大數量（預設 **2**）。

```json5
{
  tools: {
    media: {
      models: [
        /* shared list */
      ],
      image: {
        /* optional overrides */
      },
      audio: {
        /* optional overrides */
      },
      video: {
        /* optional overrides */
      },
    },
  },
}
```

### 模型項目

每個 `models[]` 項目可以是 **提供者** 或 **CLI**：

```json5
{
  type: "provider", // default if omitted
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
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
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
}
```

CLI 範本也可以使用：

- `{{MediaDir}}`（包含媒體檔案的目錄）
- `{{OutputDir}}`（為本次執行建立的暫存目錄）
- `{{OutputBase}}`（暫存檔基底路徑，無副檔名）

## 預設值與限制

建議的預設值：

- `maxChars`：影像／影片 **500**（短、利於指令）
- `maxChars`：音訊 **未設定**（除非設定限制，否則為完整逐字稿）
- `maxBytes`：
  - 影像：**10MB**
  - 音訊：**20MB**
  - 影片：**50MB**

規則：

- 若媒體超過 `maxBytes`，會略過該模型並**嘗試下一個模型**。
- 若模型回傳超過 `maxChars`，輸出會被裁切。
- `prompt` 預設為簡單的「Describe the {media}.」，並加上 `maxChars` 指引（僅影像／影片）。
- 若 `<capability>.enabled: true` 但未設定任何模型，且其提供者支援該能力，OpenClaw 會嘗試使用**目前啟用的回覆模型**。

### 自動偵測媒體理解（預設）

若未將 `tools.media.<capability>.enabled` 設為 `false`，且尚未
設定模型，OpenClaw 會依下列順序自動偵測，並在**第一個可用選項**時停止：

1. **本機 CLI**（僅音訊；若已安裝）
   - `sherpa-onnx-offline`（需要 `SHERPA_ONNX_MODEL_DIR`，含編碼器／解碼器／合併器／tokens）
   - `whisper-cli`（`whisper-cpp`；使用 `WHISPER_CPP_MODEL` 或隨附的 tiny 模型）
   - `whisper`（Python CLI；會自動下載模型）
2. **Gemini CLI**（`gemini`），使用 `read_many_files`
3. **提供者金鑰**
   - 音訊：OpenAI → Groq → Deepgram → Google
   - 影像：OpenAI → Anthropic → Google → MiniMax
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

注意：二進位檔偵測在 macOS／Linux／Windows 上為最佳努力；請確保 CLI 位於 `PATH`（我們會展開 `~`），或設定一個具有完整指令路徑的明確 CLI 模型。

## 能力（可選）

若你設定了 `capabilities`，該項目只會針對那些媒體類型執行。 對於共享清單，OpenClaw 可以推斷預設值：

- `openai`、`anthropic`、`minimax`：**影像**
- `google`（Gemini API）：**影像 + 音訊 + 影片**
- `groq`：**音訊**
- `deepgram`：**音訊**

對於 CLI 項目，**請明確設定 `capabilities`**，以避免意外的比對。
若省略 `capabilities`，該項目將符合其所在清單。
若你省略 `capabilities`，該項目會符合其所屬清單的資格。

## 提供者支援矩陣（OpenClaw 整合）

| 能力 | 提供者整合                                           | 注意事項                             |
| -- | ----------------------------------------------- | -------------------------------- |
| 影像 | OpenAI / Anthropic / Google / 透過 `pi-ai` 的其他提供者 | 登錄表中任何支援影像的模型皆可。                 |
| 音訊 | OpenAI、Groq、Deepgram、Google                     | 提供者逐字稿（Whisper／Deepgram／Gemini）。 |
| 影片 | Google（Gemini API）                              | 提供者影片理解。                         |

## 建議的提供者

**影像**

- 若目前啟用的模型支援影像，優先使用。
- 良好預設：`openai/gpt-5.2`、`anthropic/claude-opus-4-6`、`google/gemini-3-pro-preview`。

**音訊**

- `openai/gpt-4o-mini-transcribe`、`groq/whisper-large-v3-turbo` 或 `deepgram/nova-3`。
- CLI 後備：`whisper-cli`（whisper-cpp）或 `whisper`。
- Deepgram 設定：[Deepgram（音訊轉錄）](/providers/deepgram)。

**影片**

- `google/gemini-3-flash-preview`（快速）、`google/gemini-3-pro-preview`（更豐富）。
- CLI 後備：`gemini` CLI（支援影片／音訊上的 `read_file`）。

## 附件政策

各能力的 `attachments` 控制哪些附件會被處理：

- `mode`：`first`（預設）或 `all`
- `maxAttachments`：限制處理數量上限（預設 **1**）
- `prefer`：`first`、`last`、`path`、`url`

當 `mode: "all"` 時，輸出會標示為 `[Image 1/2]`、`[Audio 2/2]` 等。

## 設定範例

### 1. 共用模型清單 + 覆寫

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
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
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

### 2. 僅音訊 + 影片（影像關閉）

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
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 3. 可選的影像理解

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
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 4. 單一多模態項目（明確能力）

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

當媒體理解執行時，`/status` 會包含一行簡短摘要：

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

此內容會顯示各能力的結果，以及（適用時）所選擇的提供者／模型。

## 注意事項

- 理解為**最佳努力**。錯誤不會阻擋回覆。 錯誤不會阻擋回覆。
- 即使理解被停用，附件仍會傳遞給模型。
- 使用 `scope` 來限制理解執行的位置（例如僅限私訊）。

## 相關文件

- [設定](/gateway/configuration)
- [影像與媒體支援](/nodes/images)
