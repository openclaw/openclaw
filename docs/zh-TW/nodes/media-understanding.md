---
summary: >-
  Inbound image/audio/video understanding (optional) with provider + CLI
  fallbacks
read_when:
  - Designing or refactoring media understanding
  - Tuning inbound audio/video/image preprocessing
title: Media Understanding
---

# 媒體理解 (進口) — 2026-01-17

OpenClaw 可以在回覆流程執行之前 **總結進來的媒體**（圖片/音訊/影片）。它會自動檢測當本地工具或提供者金鑰可用時，並且可以被禁用或自定義。如果理解有誤，模型仍然會像往常一樣接收原始檔案/網址。

## 目標

- 可選：將進入的媒體預先處理為短文本，以便更快的路由和更好的命令解析。
- 保留原始媒體傳遞給模型（始終）。
- 支援 **provider APIs** 和 **CLI fallbacks**。
- 允許多個模型按順序回退（錯誤/大小/超時）。

## 高階行為

1. 收集進來的附件 (`MediaPaths`, `MediaUrls`, `MediaTypes`)。
2. 對於每個啟用的功能（圖像/音頻/影片），根據政策選擇附件（預設：**第一個**）。
3. 選擇第一個符合條件的模型條目（大小 + 功能 + 認證）。
4. 如果模型失敗或媒體過大，**回退到下一個條目**。
5. 成功時：
   - `Body` 變成 `[Image]`、`[Audio]` 或 `[Video]` 區塊。
   - 音頻設置 `{{Transcript}}`；命令解析在有標題文本時使用該文本，否則使用逐字稿。
   - 標題作為 `User text:` 保留在區塊內。

如果理解失敗或被禁用，**回覆流程將繼續**使用原始內容 + 附件。

## 設定概述

`tools.media` 支援 **共享模型** 以及每個功能的覆蓋設定：

- `tools.media.models`: 共享模型列表（使用 `capabilities` 進行控制）。
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - 預設值 (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - 提供者覆寫 (`baseUrl`, `headers`, `providerOptions`)
  - 透過 `tools.media.audio.providerOptions.deepgram` 的 Deepgram 音訊選項
  - 音訊轉錄回音控制 (`echoTranscript`, 預設 `false`; `echoFormat`)
  - 可選的 **每項能力 `models` 列表**（在共享模型之前優先考慮）
  - `attachments` 政策 (`mode`, `maxAttachments`, `prefer`)
  - `scope`（可選的按通道/聊天類型/會話金鑰進行控制）
- `tools.media.concurrency`: 最大同時能力執行數（預設 **2**）。

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
        echoTranscript: true,
        echoFormat: '📝 "{transcript}"',
      },
      video: {
        /* optional overrides */
      },
    },
  },
}
```

### 模型條目

每個 `models[]` 專案可以是 **provider** 或 **CLI**：

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

CLI 模板也可以使用：

- `{{MediaDir}}` （包含媒體檔案的目錄）
- `{{OutputDir}}` （為此次執行創建的臨時目錄）
- `{{OutputBase}}` （臨時檔案的基本路徑，無擴充名）

## 預設值和限制

建議的預設值：

- `maxChars`: **500** 用於影像/影片（簡短、命令友好）
- `maxChars`: **unset** 用於音訊（完整逐字稿，除非您設定限制）
- `maxBytes`:
  - 影像: **10MB**
  - 音訊: **20MB**
  - 影片: **50MB**

規則：

- 如果媒體超過 `maxBytes`，則該模型將被跳過，並且**嘗試下一個模型**。
- 小於 **1024 bytes** 的音訊檔案將被視為空的/損壞的，並在提供者/CLI 轉錄之前被跳過。
- 如果模型返回的結果超過 `maxChars`，則輸出將被修剪。
- `prompt` 預設為簡單的 “描述 {media}。” 加上 `maxChars` 指導（僅限影像/影片）。
- 如果 `<capability>.enabled: true` 但沒有設定模型，OpenClaw 將在其提供者支援該功能時嘗試**活動回覆模型**。

### 自動偵測媒體理解（預設）

如果 `tools.media.<capability>.enabled` **未** 設定為 `false` 且您尚未設定模型，OpenClaw 會按照以下順序自動檢測並 **在第一個可用選項處停止**：

1. **本地 CLI** (僅音訊；如果已安裝)
   - `sherpa-onnx-offline` (需要 `SHERPA_ONNX_MODEL_DIR` 以及編碼器/解碼器/合併器/token)
   - `whisper-cli` (`whisper-cpp`; 使用 `WHISPER_CPP_MODEL` 或捆綁的小型模型)
   - `whisper` (Python CLI; 自動下載模型)
2. **Gemini CLI** (`gemini`) 使用 `read_many_files`
3. **提供者金鑰**
   - 音訊: OpenAI → Groq → Deepgram → Google
   - 圖像: OpenAI → Anthropic → Google → MiniMax
   - 影片: Google

要禁用自動檢測，請設置：

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

注意：二進位檢測在 macOS/Linux/Windows 上是最佳努力的；確保 CLI 在 `PATH` 上（我們擴充 `~`），或使用完整命令路徑設置明確的 CLI 模型。

### 代理環境支援（提供者模型）

當啟用基於提供者的 **音訊** 和 **影片** 媒體理解時，OpenClaw 會遵循標準的外部代理環境變數以進行提供者的 HTTP 呼叫：

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `https_proxy`
- `http_proxy`

如果沒有設置代理環境變數，媒體理解將使用直接出口。如果代理值格式不正確，OpenClaw 會記錄一個警告並回退到直接獲取。

## 功能 (選填)

如果您設置 `capabilities`，則該條目僅對那些媒體類型執行。對於共享列表，OpenClaw 可以推斷預設值：

- `openai`, `anthropic`, `minimax`: **影像**
- `google` (Gemini API): **影像 + 音訊 + 影片**
- `groq`: **音訊**
- `deepgram`: **音訊**

對於 CLI 條目，**明確設置 `capabilities`** 以避免意外匹配。  
如果您省略 `capabilities`，則該條目有資格出現在它所出現的列表中。

## 提供者支援矩陣 (OpenClaw 整合)

| 能力 | 供應商整合                                     | 備註                                            |
| ---- | ---------------------------------------------- | ----------------------------------------------- |
| 圖像 | OpenAI / Anthropic / Google / 其他透過 `pi-ai` | 註冊中的任何具圖像能力的模型均可使用。          |
| 音訊 | OpenAI, Groq, Deepgram, Google, Mistral        | 供應商轉錄（Whisper/Deepgram/Gemini/Voxtral）。 |
| 影片 | Google (Gemini API)                            | 供應商影片理解。                                |

## 模型選擇指導

- 當品質和安全性重要時，優先選擇每個媒體能力中可用的最強最新一代模型。
- 對於處理不受信任輸入的工具啟用代理，避免使用舊的/較弱的媒體模型。
- 每個能力至少保留一個備用選項以確保可用性（品質模型 + 更快/更便宜的模型）。
- 當提供者的 API 無法使用時，CLI 備用選項 (`whisper-cli`, `whisper`, `gemini`) 是有用的。
- `parakeet-mlx` 注意：使用 `--output-dir` 時，OpenClaw 在輸出格式為 `txt`（或未指定）時讀取 `<output-dir>/<media-basename>.txt`；非 `txt` 格式則回退到 stdout。

## 附件政策

每個能力 `attachments` 控制哪些附件被處理：

- `mode`: `first`（預設）或 `all`
- `maxAttachments`: 限制處理的數量（預設 **1**）
- `prefer`: `first`、`last`、`path`、`url`

當 `mode: "all"` 時，輸出標記為 `[Image 1/2]`、`[Audio 2/2]` 等等。

## 設定範例

### 1) 共享模型列表 + 覆蓋設定

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

### 2) 僅音訊 + 視訊（影像關閉）

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

### 3) 可選的影像理解

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

### 4) 多模態單一入口（明確能力）

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## 狀態輸出

當媒體理解執行時，`/status` 包含一行簡短的摘要：

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

這顯示了每項能力的結果以及在適用時所選擇的提供者/模型。

## 註解

- 理解是 **最佳努力**。錯誤不會阻止回覆。
- 附件仍然會在理解被禁用時傳遞給模型。
- 使用 `scope` 來限制理解執行的範圍（例如僅限於私訊）。

## 相關文件

- [設定](/gateway/configuration)
- [圖像與媒體支援](/nodes/images)
