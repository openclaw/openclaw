---
summary: "針對傳入語音訊息的 Deepgram 逐字稿功能"
read_when:
  - 您希望為音訊附件使用 Deepgram 語音轉文字功能
  - 您需要快速查看 Deepgram 設定範例
title: "Deepgram"
---

# Deepgram (音訊逐字稿)

Deepgram 是一個語音轉文字 API。在 OpenClaw 中，它透過 `tools.media.audio` 用於 **傳入音訊/語音訊息的逐字稿轉換**。

啟用時，OpenClaw 會將音訊檔案上傳至 Deepgram，並將逐字稿注入回覆流程中（`{{Transcript}}` + `[Audio]` 區塊）。這 **不是串流傳輸**；它使用的是預錄音訊逐字稿端點。

網站：[https://deepgram.com](https://deepgram.com)  
文件：[https://developers.deepgram.com](https://developers.deepgram.com)

## 快速開始

1. 設定您的 API 金鑰：

```
DEEPGRAM_API_KEY=dg_...
```

2. 啟用供應商：

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

## 選項

- `model`: Deepgram 模型 ID（預設：`nova-3`）
- `language`: 語言提示（選填）
- `tools.media.audio.providerOptions.deepgram.detect_language`: 啟用語言偵測（選填）
- `tools.media.audio.providerOptions.deepgram.punctuate`: 啟用標點符號（選填）
- `tools.media.audio.providerOptions.deepgram.smart_format`: 啟用智慧格式化（選填）

包含語言設定的範例：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

包含 Deepgram 選項的範例：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## 注意事項

- 身份驗證遵循標準供應商驗證順序；使用 `DEEPGRAM_API_KEY` 是最簡單的方式。
- 使用代理伺服器時，可透過 `tools.media.audio.baseUrl` 和 `tools.media.audio.headers` 覆寫端點或標頭。
- 輸出遵循與其他供應商相同的音訊規則（大小限制、逾時、逐字稿注入）。
