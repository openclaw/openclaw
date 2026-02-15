---
summary: "內送圖片/音訊/視訊理解（選用）搭配供應商 + CLI 備用"
read_when:
  - 設計或重構媒體理解
  - 調整內送音訊/視訊/圖片預處理
title: "媒體理解"
---

# 媒體理解 (內送) — 2026-01-17

OpenClaw 可以在回覆流程執行前，**摘要內送媒體**（圖片/音訊/視訊）。它會自動偵測何時可使用本機工具或供應商金鑰，並且可以停用或自訂。如果理解功能關閉，模型仍會照常接收原始檔案/URL。

## 目標

- 選用：將內送媒體預先消化為短文字，以實現更快的路由 + 更好的指令解析。
- 始終保留原始媒體傳遞給模型。
- 支援**供應商 API** 和 **CLI 備用**。
- 允許多個模型依序備用（錯誤/大小/逾時）。

## 高階行為

1. 收集內送附件（`MediaPaths`、`MediaUrls`、`MediaTypes`）。
2. 對於每個已啟用的功能（圖片/音訊/視訊），根據策略選擇附件（預設：**第一個**）。
3. 選擇第一個符合資格的模型項目（大小 + 功能 + 憑證）。
4. 如果模型失敗或媒體過大，**則備用至下一個項目**。
5. 成功時：
   - `Body` 變成 `[Image]`、`[Audio]` 或 `[Video]` 區塊。
   - 音訊設定 `{{Transcript}}`；指令解析會使用存在的字幕文字，否則使用逐字稿。
   - 字幕會以 `User text:` 的形式保留在區塊內。

如果理解失敗或被停用，**回覆流程會繼續**使用原始主體 + 附件。

## 設定概述

`tools.media` 支援**共享模型**以及每個功能覆寫：

- `tools.media.models`：共享模型列表（使用 `capabilities` 進行門控）。
- `tools.media.image` / `tools.media.audio` / `tools.media.video`：
  - 預設值（`prompt`、`maxChars`、`maxBytes`、`timeoutSeconds`、`language`）
  - 供應商覆寫（`baseUrl`、`headers`、`providerOptions`）
  - 透過 `tools.media.audio.providerOptions.deepgram` 的 Deepgram 音訊選項
  - 選用**每個功能的 `models` 列表**（優先於共享模型）
  - `attachments` 策略（`mode`、`maxAttachments`、`prefer`）
  - `scope`（選用，按頻道/聊天類型/工作階段金鑰進行門控）
- `tools.media.concurrency`：最大併發功能執行次數（預設**2**）。

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

每個 `models[]` 項目可以是**供應商**或 **CLI**：

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
- `{{OutputDir}}`（為此執行建立的暫存目錄）
- `{{OutputBase}}`（暫存檔案的基本路徑，無副檔名）

## 預設值與限制

建議預設值：

- `maxChars`：圖片/視訊**500**（簡短，指令友善）
- `maxChars`：音訊**未設定**（完整逐字稿，除非您設定限制）
- `maxBytes`：
  - 圖片：**10MB**
  - 音訊：**20MB**
  - 視訊：**50MB**

規則：

- 如果媒體超出 `maxBytes`，該模型將被跳過並**嘗試下一個模型**。
- 如果模型傳回的字元數超過 `maxChars`，則輸出將被截斷。
- `prompt` 預設為簡單的「描述 {媒體}。」加上 `maxChars` 指導（僅限圖片/視訊）。
- 如果 `<capability>.enabled: true` 但未配置模型，OpenClaw 會在供應商支援該功能時嘗試**活動回覆模型**。

### 自動偵測媒體理解（預設）

如果 `tools.media.<capability>.enabled` **未**設定為 `false` 且您尚未配置模型，OpenClaw 將按此順序自動偵測並**在第一個有效選項處停止**：

1. **本機 CLI**（僅限音訊；如果已安裝）
   - `sherpa-onnx-offline`（需要包含編碼器/解碼器/合併器/標記的 `SHERPA_ONNX_MODEL_DIR`）
   - `whisper-cli`（`whisper-cpp`；使用 `WHISPER_CPP_MODEL` 或捆綁的微型模型）
   - `whisper` (Python CLI；自動下載模型)
2. **Gemini CLI** (`gemini`) 使用 `read_many_files`
3. **供應商金鑰**
   - 音訊：OpenAI → Groq → Deepgram → Google
   - 圖片：OpenAI → Anthropic → Google → MiniMax
   - 視訊：Google

要停用自動偵測，請設定：

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

注意：二進位偵測在 macOS/Linux/Windows 上盡力而為；請確保 CLI 位於 `PATH`（我們會展開 `~`），或設定一個帶有完整命令路徑的明確 CLI 模型。

## 功能（選用）

如果您設定 `capabilities`，該項目僅適用於這些媒體類型。對於共享列表，OpenClaw 可以推斷預設值：

- `openai`、`anthropic`、`minimax`：**圖片**
- `google` (Gemini API)：**圖片 + 音訊 + 視訊**
- `groq`：**音訊**
- `deepgram`：**音訊**

對於 CLI 項目，**明確設定 `capabilities`** 以避免意外匹配。如果您省略 `capabilities`，該項目將適用於其所出現的列表。

## 供應商支援矩陣（OpenClaw 整合）

| 功能 | 供應商整合                             | 備註                                     |
| ---- | -------------------------------------- | ---------------------------------------- |
| 圖片 | OpenAI / Anthropic / Google / 其他透過 `pi-ai` | 登錄中任何支援圖片的模型皆可運作。       |
| 音訊 | OpenAI, Groq, Deepgram, Google         | 供應商轉錄（Whisper/Deepgram/Gemini）。 |
| 視訊 | Google (Gemini API)                    | 供應商視訊理解。                         |

## 推薦供應商

**圖片**

- 如果您的活動模型支援圖片，請優先使用。
- 良好預設值：`openai/gpt-5.2`、`anthropic/claude-opus-4-6`、`google/gemini-3-pro-preview`。

**音訊**

- `openai/gpt-4o-mini-transcribe`、`groq/whisper-large-v3-turbo` 或 `deepgram/nova-3`。
- CLI 備用：`whisper-cli` (whisper-cpp) 或 `whisper`。
- Deepgram 設定：[Deepgram (音訊轉錄)](/providers/deepgram)。

**視訊**

- `google/gemini-3-flash-preview`（快速）、`google/gemini-3-pro-preview`（更豐富）。
- CLI 備用：`gemini` CLI（支援視訊/音訊的 `read_file`）。

## 附件策略

每個功能的 `attachments` 控制處理哪些附件：

- `mode`：`first`（預設）或 `all`
- `maxAttachments`：限制處理數量（預設**1**）
- `prefer`：`first`、`last`、`path`、`url`

當 `mode: "all"` 時，輸出會標記為 `[Image 1/2]`、`[Audio 2/2]` 等。

## 設定範例

### 1) 共享模型列表 + 覆寫

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

### 2) 僅音訊 + 視訊（關閉圖片）

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

### 3) 選用圖片理解

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

### 4) 多模態單一項目（明確功能）

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

當媒體理解執行時，`/status` 會包含一行簡短的摘要：

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

這會顯示每個功能的結果以及適用的供應商/模型。

## 備註

- 理解是**盡力而為**。錯誤不會阻擋回覆。
- 即使理解功能被停用，附件仍會傳遞給模型。
- 使用 `scope` 限制理解執行的位置（例如僅限私訊）。

## 相關文件

- [設定](/gateway/configuration)
- [圖片與媒體支援](/nodes/images)
