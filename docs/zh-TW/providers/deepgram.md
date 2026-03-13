---
summary: Deepgram transcription for inbound voice notes
read_when:
  - You want Deepgram speech-to-text for audio attachments
  - You need a quick Deepgram config example
title: Deepgram
---

# Deepgram（語音轉文字）

Deepgram 是一個語音轉文字的 API。在 OpenClaw 中，它用於 **來電音訊／語音訊息的轉錄**，透過 `tools.media.audio`。

啟用後，OpenClaw 會將音訊檔上傳至 Deepgram，並將轉錄文字注入回覆流程 (`{{Transcript}}` + `[Audio]` 區塊)。這不是 **串流**；而是使用預先錄製的轉錄端點。

網站： [https://deepgram.com](https://deepgram.com)  
文件： [https://developers.deepgram.com](https://developers.deepgram.com)

## 快速開始

1. 設定您的 API 金鑰：

```
DEEPGRAM_API_KEY=dg_...
```

2. 啟用此服務提供者：

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

- `model`：Deepgram 模型 ID（預設值：`nova-3`）
- `language`：語言提示（可選）
- `tools.media.audio.providerOptions.deepgram.detect_language`：啟用語言偵測（可選）
- `tools.media.audio.providerOptions.deepgram.punctuate`：啟用標點符號（可選）
- `tools.media.audio.providerOptions.deepgram.smart_format`：啟用智慧格式化（可選）

帶語言設定的範例：

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

帶 Deepgram 選項的範例：

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

## 備註

- 認證遵循標準提供者的驗證順序；`DEEPGRAM_API_KEY` 是最簡單的路徑。
- 使用代理時，可透過 `tools.media.audio.baseUrl` 和 `tools.media.audio.headers` 覆寫端點或標頭。
- 輸出遵循與其他提供者相同的音訊規則（大小限制、逾時、文字稿注入）。
